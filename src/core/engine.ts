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

export class OffDiffEngine {
  private graphService: GraphifyService;
  private aiService: AIService;

  constructor(graphCmd?: string) {
    this.graphService = new GraphifyService(graphCmd);
    this.aiService = new AIService();
  }

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

    // 5. Verify claims against code changes
    const { claims, findings, untouchedCallers } = await verifier.verifyAll(
      activeSummary,
      graphResult.graphData,
      request.useAi
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

    if (contradictedCount > 0 || untouchedCallersCount > 0) {
      overallVerdict = 'FAILED';
      if (untouchedCallers.length > 0) {
        const first = untouchedCallers[0];
        suggestedAction = `Action Required: Update untouched caller '${first.caller}' in ${first.file}:${first.line} to pass the required arguments to '${first.symbol}'.`;
      } else {
        suggestedAction = 'Action Required: Code changes contradict the completion claim. Inspect conflicting evidence before proceeding.';
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

  private detectChangedFunctions(changes: any[]): ChangedFunction[] {
    const list: ChangedFunction[] = [];
    const seen = new Set<string>();

    for (const fileChange of changes) {
      for (const hunk of fileChange.diffHunks) {
        const lines = hunk.content.split('\n');
        let oldSig = '';
        let newSig = '';

        for (const line of lines) {
          if (line.startsWith('-') && !line.startsWith('---')) {
            const m = line.match(/^-\s*(?:def|function)\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)/);
            if (m) oldSig = `${m[1]}(${m[2].trim()})`;
          } else if (line.startsWith('+') && !line.startsWith('+++')) {
            const m = line.match(/^\+\s*(?:def|function)\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)/);
            if (m) {
              const fnName = m[1];
              newSig = `${fnName}(${m[2].trim()})`;
              const key = `${fileChange.path}:${fnName}`;
              if (!seen.has(key)) {
                seen.add(key);
                list.push({
                  name: fnName,
                  file: fileChange.path,
                  line: hunk.newStart,
                  oldSignature: oldSig || undefined,
                  newSignature: newSig,
                  snippet: line.slice(1).trim(),
                });
              }
            }
          }
        }
      }
    }

    return list;
  }

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
