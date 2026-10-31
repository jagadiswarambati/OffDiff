/**
 * @file engine.ts
 * @description Central orchestration engine for OffDiff.
 * Coordinates the full verification pipeline:
 * 1. Git repository inspection & diff parsing
 * 2. Tree-sitter Graphify code knowledge graph generation
 * 3. Changed function & signature detection across multiple programming languages
 * 4. AST missed-caller detection & call site mapping
 * 5. Claim verification with optional Gemma 4 semantic investigation
 * 6. Verdict calculation & actionable next steps generation
 */

import path from 'node:path';
import fs from 'node:fs';
import { inspectGitRepository } from './git';
import { GraphifyService } from './graphify';
import { MissedCallerDetector } from './detector';
import { ClaimVerifier } from './verifier';
import { AIService } from './ai';
import {
  VerificationRequest,
  VerificationResult,
  VerificationRequestSchema,
  VerificationResultSchema,
  ChangedFunction,
  DependencyRelationship,
} from './types';

/**
 * Main verification engine orchestrating deterministic and AI checks.
 */
export class OffDiffEngine {
  private graphService: GraphifyService;
  private aiService: AIService;

  /**
   * Initializes the engine with optional custom Graphify command override.
   * @param graphCmd Custom CLI command to invoke Graphify
   */
  constructor(graphCmd?: string) {
    this.graphService = new GraphifyService(graphCmd);
    this.aiService = new AIService();
  }

  /**
   * Runs the complete verification pipeline for a repository and completion claim.
   *
   * @param rawRequest Raw or partially specified VerificationRequest object
   * @returns Comprehensive VerificationResult matching VerificationResultSchema
   */
  async runVerification(rawRequest: VerificationRequest): Promise<VerificationResult> {
    const request = VerificationRequestSchema.parse(rawRequest);
    const runId = `offdiff-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const timestamp = new Date().toISOString();

    // 1. Inspect Git repository
    const gitResult = await inspectGitRepository(request.repoPath, request.baseRevision);

    // 2. Identify changed functions in git diff
    const changedFunctions = this.detectChangedFunctions(gitResult.changes);

    // 3. Run Graphify to construct code knowledge graph
    const graphResult = await this.graphService.generateGraph(gitResult.repoPath);

    // 4. Initialize detector & verifier
    const detector = new MissedCallerDetector(
      gitResult.repoPath,
      gitResult.changes,
      this.graphService
    );
    const verifier = new ClaimVerifier(
      gitResult.repoPath,
      gitResult.changes,
      detector,
      this.aiService
    );

    // Determine active summary: if empty or if demo claim used on a non-demo repo, auto-detect from git commit
    let activeSummary = (request.summary || '').trim();
    const isDemoClaim = activeSummary === 'Updated all callers of get_price to pass the currency.';
    const isNotDemoRepo = !gitResult.repoPath.endsWith('demo-repo') &&
                          !gitResult.repoPath.endsWith('demo-repo\\') &&
                          !gitResult.repoPath.endsWith('demo-repo/');

    if (!activeSummary || (isDemoClaim && isNotDemoRepo && gitResult.commitSubject)) {
      activeSummary = gitResult.commitSubject || gitResult.commitMessage || 'Code changes in recent commit';
    }

    // 5. Verify claims against code changes and inspect ALL changed functions in the diff
    const { claims, findings, untouchedCallers } = await verifier.verifyAll(
      activeSummary,
      graphResult.graphData,
      request.useAi,
      changedFunctions
    );

    // 6. Build dependency relationships (from Graphify or fallback AST scan)
    const modifiedLinesByFile = new Map<string, Set<number>>();
    for (const change of gitResult.changes) {
      modifiedLinesByFile.set(change.path.replace(/\\/g, '/'), new Set(change.modifiedLines));
    }

    let dependencyRelationships: DependencyRelationship[] = [];
    if (graphResult.graphData) {
      dependencyRelationships = this.graphService.extractRelationships(
        graphResult.graphData,
        modifiedLinesByFile
      );
    } else {
      // Fallback: build dependency relationships using AST detector
      dependencyRelationships = await this.buildFallbackRelationships(
        detector,
        changedFunctions,
        modifiedLinesByFile
      );
    }

    // 7. Calculate statistics & overall verdict
    const verifiedCount = claims.filter(c => c.status === 'VERIFIED' || c.status === 'UPDATED').length;
    const contradictedCount = claims.filter(c => c.status === 'CONTRADICTED' || c.status === 'UNTOUCHED').length;
    const atRiskCount = claims.filter(c => c.status === 'AT RISK').length;
    const unverifiableCount = claims.filter(c => c.status === 'UNVERIFIABLE').length;
    const untouchedCallersCount = untouchedCallers.length;

    let overallVerdict: 'PASSED' | 'FAILED' | 'WARNING' = 'PASSED';
    let suggestedAction = '';

    // 8. Generate comprehensive actionable next steps listing ALL discovered problems
    if (contradictedCount > 0 || untouchedCallersCount > 0) {
      overallVerdict = 'FAILED';
      if (untouchedCallers.length > 0) {
        if (untouchedCallers.length === 1) {
          const first = untouchedCallers[0];
          suggestedAction = `Action Required (1 untouched caller): Update caller '${first.caller}' in ${first.file}:${first.line} calling '${first.symbol}'.`;
        } else {
          // List ALL untouched callers discovered across the codebase
          const summaryList = untouchedCallers
            .map((u, i) => `${i + 1}) '${u.caller}' in ${u.file}:${u.line} (calls '${u.symbol}')`)
            .join('; ');
          suggestedAction = `Action Required (${untouchedCallers.length} untouched callers detected): Update callers: ${summaryList}`;
        }
      } else {
        const contradictedList = claims
          .filter(c => c.status === 'CONTRADICTED')
          .map(c => `"${c.rawText}"`)
          .join(', ');
        suggestedAction = `Action Required (${contradictedCount} claim(s) contradicted): Code changes contradict completion claim(s) ${contradictedList}. Inspect conflicting evidence before proceeding.`;
      }
    } else if (atRiskCount > 0 || (request.strict && !graphResult.status.executed)) {
      overallVerdict = 'WARNING';
      suggestedAction = 'Review Needed: Function signatures were modified without default parameters or Graphify coverage was partial under strict mode.';
    } else if (claims.length > 0 && verifiedCount === 0 && unverifiableCount === claims.length) {
      overallVerdict = 'WARNING';
      const repoName = gitResult.repoPath.split(/[\\/]/).pop();
      suggestedAction = `Claim Unverifiable: No relevant symbols or callers for the claim were found in this codebase (${repoName}). Latest commit: "${gitResult.commitSubject || 'N/A'}". Try using the repository's actual commit claim or symbols.`;
    } else if (verifiedCount > 0) {
      overallVerdict = 'PASSED';
      suggestedAction = `All ${verifiedCount} refactored caller(s) and code changes verified with zero untouched callers detected. Ready to merge.`;
    } else {
      overallVerdict = 'PASSED';
      if (changedFunctions.length > 0) {
        suggestedAction = `Verified ${changedFunctions.length} changed function(s) in git diff with zero broken callers detected. Ready to merge.`;
      } else if (gitResult.changes.length > 0) {
        suggestedAction = `Verified ${gitResult.changes.length} modified file(s) in ${gitResult.commitSubject ? `"${gitResult.commitSubject}"` : 'diff'} with zero code breakages. Ready to merge.`;
      } else {
        suggestedAction = 'No code changes detected in this revision range. Working tree clean.';
      }
    }

    const aiNotes = this.aiService.isConfigured()
      ? `Active (${this.aiService.getModelName()})`
      : 'API key not configured; using deterministic verification';

    const result: VerificationResult = {
      id: runId,
      timestamp,
      repoPath: gitResult.repoPath,
      baseRevision: gitResult.baseRevision,
      headRevision: gitResult.headRevision,
      commitInfo: {
        subject: gitResult.commitSubject,
        message: gitResult.commitMessage,
        author: gitResult.commitAuthor,
        date: gitResult.commitDate,
      },
      summary: activeSummary,
      overallVerdict,
      strict: request.strict,
      suggestedAction,
      changedFunctions,
      dependencyRelationships,
      claims,
      findings,
      untouchedCallers,
      gitChanges: gitResult.changes,
      graphify: graphResult.status,
      aiStatus: {
        used: request.useAi && this.aiService.isConfigured(),
        model: this.aiService.getModelName(),
        notes: aiNotes,
      },
      stats: {
        totalClaims: claims.length,
        verified: verifiedCount,
        contradicted: contradictedCount,
        atRisk: atRiskCount,
        untouchedCallers: untouchedCallersCount,
      },
    };

    return VerificationResultSchema.parse(result);
  }

  /**
   * Identifies all functions modified in the Git diff across all supported languages.
   * Parses additions and deletions to detect signature changes, parameter additions/removals,
   * and newly introduced functions.
   *
   * Supports:
   * - Python: def foo(args), async def foo(args)
   * - JavaScript/TypeScript: function foo(args), async function foo(args), export function foo(args)
   * - JS/TS Arrow & Expression Functions: const foo = (args) =>, export const foo = (args) =>
   * - Go: func (r *Receiver) Foo(args), func Foo(args)
   * - Rust: fn foo(args), pub fn foo(args)
   */
  private detectChangedFunctions(changes: any[]): ChangedFunction[] {
    const list: ChangedFunction[] = [];
    const seen = new Set<string>();

    for (const fileChange of changes) {
      for (const hunk of fileChange.diffHunks) {
        const lines = hunk.content.split('\n');
        let oldSig = '';

        for (const line of lines) {
          if (line.startsWith('-') && !line.startsWith('---')) {
            const stripped = line.slice(1).trim();
            const fn = this.parseFunctionSignatureLine(stripped);
            if (fn) oldSig = fn.signature;
          } else if (line.startsWith('+') && !line.startsWith('+++')) {
            const stripped = line.slice(1).trim();
            const fn = this.parseFunctionSignatureLine(stripped);
            if (fn) {
              const key = `${fileChange.path}:${fn.name}`;
              if (!seen.has(key)) {
                seen.add(key);
                list.push({
                  name: fn.name,
                  file: fileChange.path,
                  line: hunk.newStart,
                  oldSignature: oldSig || undefined,
                  newSignature: fn.signature,
                  snippet: stripped,
                });
              }
            }
          }
        }
      }
    }

    return list;
  }

  /**
   * Helper function to match and parse function declarations across multiple programming languages.
   * Extracts the function identifier and reconstructed parameter signature string.
   *
   * @param line Single line of source text stripped of diff prefixes
   * @returns Object with function name and formatted signature, or null if line is not a function declaration
   */
  private parseFunctionSignatureLine(line: string): { name: string; signature: string } | null {
    // 1. Python def / async def
    const py = line.match(/^(?:async\s+)?def\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)/);
    if (py) return { name: py[1], signature: `${py[1]}(${py[2].trim()})` };

    // 2. JS/TS standard: [export [default]] [async] function foo(args)
    const jsFn = line.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)/);
    if (jsFn) return { name: jsFn[1], signature: `${jsFn[1]}(${jsFn[2].trim()})` };

    // 3. JS/TS arrow/expression: [export] const/let/var foo = [async] (args) =>
    const jsArrow = line.match(/^(?:export\s+)?(?:const|let|var)\s+([a-zA-Z0-9_]+)\s*=\s*(?:async\s*)?(?:\(([^)]*)\)|([a-zA-Z0-9_]+))\s*=>/);
    if (jsArrow) {
      const args = (jsArrow[2] || jsArrow[3] || '').trim();
      return { name: jsArrow[1], signature: `${jsArrow[1]}(${args})` };
    }

    // 4. Go functions: func (r Receiver) Name(args) or func Name(args)
    const goFn = line.match(/^func\s+(?:\([^)]*\)\s+)?([a-zA-Z0-9_]+)\s*\(([^)]*)\)/);
    if (goFn) return { name: goFn[1], signature: `${goFn[1]}(${goFn[2].trim()})` };

    // 5. Rust functions: [pub] [async] fn name(args)
    const rustFn = line.match(/^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)/);
    if (rustFn) return { name: rustFn[1], signature: `${rustFn[1]}(${rustFn[2].trim()})` };

    return null;
  }

  /**
   * Constructs dependency caller relationships using source file AST scanning when Graphify is unavailable.
   * Maps call sites for each changed function and compares their locations against the Git diff modified lines.
   *
   * @param detector MissedCallerDetector instance
   * @param changedFns Functions modified in the Git diff
   * @param modifiedLinesByFile Mapping of relative file paths to their modified line number sets
   * @returns Array of DependencyRelationship objects with CHANGED or UNCHANGED status
   */
  private async buildFallbackRelationships(
    detector: MissedCallerDetector,
    changedFns: ChangedFunction[],
    modifiedLinesByFile: Map<string, Set<number>>
  ): Promise<DependencyRelationship[]> {
    const rels: DependencyRelationship[] = [];

    for (const fn of changedFns) {
      const callSites = await detector.detectCallers(fn.name);
      for (const site of callSites) {
        rels.push({
          caller: site.caller,
          callee: fn.name,
          relation: 'calls',
          file: site.file,
          line: site.line,
          status: site.status === 'UPDATED' ? 'CHANGED' : 'UNCHANGED',
          source: 'ast_fallback',
        });
      }
    }

    return rels;
  }
}
