/**
 * @file verifier.ts
 * @description Claim verification engine for OffDiff.
 * Parses agent completion summaries into structured claims (e.g. caller updates,
 * removed references, breaking change claims, signature changes). Evaluates each claim
 * deterministically against Git diffs and Graphify AST graphs, cross-checks all modified
 * functions in the diff for untouched callers across the repository, and optionally
 * consults Gemma 4 AI for semantic ambiguity analysis.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  Claim,
  ClaimVerdict,
  FindingEvidence,
  GitFileChange,
  UntouchedCaller,
  ChangedFunction,
} from './types';
import { MissedCallerDetector } from './detector';
import { GraphifyGraphData } from './graphify';
import { AIService } from './ai';

/**
 * Raw claim extracted from an agent completion summary.
 */
export interface ExtractedClaimRaw {
  /** Original raw text line describing the claim */
  rawText: string;
  /** Categorized claim type (callers_updated, reference_removed, etc.) */
  type: Claim['type'];
  /** Extracted symbol name (function, variable, or class) */
  targetSymbol?: string;
  /** Optional conditional phrase (e.g., arguments passed) */
  condition?: string;
}

/**
 * ClaimVerifier evaluates claims against real Git diffs and code graphs.
 */
export class ClaimVerifier {
  private repoPath: string;
  private gitChanges: GitFileChange[];
  private detector: MissedCallerDetector;
  private aiService: AIService;

  /**
   * Constructs a ClaimVerifier instance.
   *
   * @param repoPath Absolute or relative repository root path
   * @param gitChanges Collection of parsed Git file changes with modified line numbers
   * @param detector MissedCallerDetector instance to locate call sites
   * @param aiService Optional AIService instance for semantic checks
   */
  constructor(
    repoPath: string,
    gitChanges: GitFileChange[],
    detector: MissedCallerDetector,
    aiService?: AIService
  ) {
    this.repoPath = path.resolve(repoPath);
    this.gitChanges = gitChanges;
    this.detector = detector;
    this.aiService = aiService || new AIService();
  }

  /**
   * Parse completion summary into discrete claims
   */
  extractClaimsFromSummary(summary: string): ExtractedClaimRaw[] {
    const rawLines = summary
      .split(/\r?\n|[.;](?=\s+[A-Z])/)
      .map(s => s.trim())
      .filter(s => s.length > 5);

    if (rawLines.length === 0 && summary.trim().length > 0) {
      rawLines.push(summary.trim());
    }

    const claims: ExtractedClaimRaw[] = [];

    for (const text of rawLines) {
      // 1. "Updated all callers of <symbol>..."
      const callersMatch = text.match(/(?:update|modify|change|refactor)(?:d|ed)?\s+all\s+(?:callers|references|usages)\s+of\s+([`'"]?)([a-zA-Z0-9_]+)\1(?:\s+to\s+(.+))?/i) ||
                           text.match(/all\s+callers\s+of\s+([`'"]?)([a-zA-Z0-9_]+)\1\s+(?:were|have\s+been|are)\s+updated/i);

      if (callersMatch) {
        claims.push({
          rawText: text,
          type: 'callers_updated',
          targetSymbol: callersMatch[2],
          condition: callersMatch[3]?.trim(),
        });
        continue;
      }

      // 2. "Removed every/all reference to <symbol>..."
      const removeMatch = text.match(/(?:remove|delete|eliminate)(?:d|ed)?\s+(?:every|all|any)\s+(?:reference|call|usage|occurrence)s?\s+(?:to|of)\s+([`'"]?)([a-zA-Z0-9_]+)\1/i) ||
                          text.match(/no\s+(?:more\s+)?references?\s+to\s+([`'"]?)([a-zA-Z0-9_]+)\1/i);

      if (removeMatch) {
        claims.push({
          rawText: text,
          type: 'reference_removed',
          targetSymbol: removeMatch[2],
        });
        continue;
      }

      // 3. "No breaking changes"
      if (/no\s+breaking\s+changes?/i.test(text) || /backward(?:s)?\s+compatible/i.test(text)) {
        claims.push({
          rawText: text,
          type: 'no_breaking_changes',
        });
        continue;
      }

      // 4. Function signature change
      const sigMatch = text.match(/(?:update|add|change|modify)(?:d|ed)?\s+(?:signature|parameter|argument)s?\s+(?:of|for)\s+([`'"]?)([a-zA-Z0-9_]+)\1/i);
      if (sigMatch) {
        claims.push({
          rawText: text,
          type: 'signature_change',
          targetSymbol: sigMatch[2],
        });
        continue;
      }

      // Fallback: general claim
      // Try to extract any function symbol mentioned in backticks or quotes
      const symbolMatch = text.match(/[`'"]([a-zA-Z0-9_]+)[`'"]/);
      claims.push({
        rawText: text,
        type: 'general',
        targetSymbol: symbolMatch ? symbolMatch[1] : undefined,
      });
    }

    return claims;
  }

  /**
   * Verify all extracted claims against code changes and codebase state,
   * AND automatically inspect EVERY changed function across the entire git diff
   * to catch all untouched callers and broken dependencies.
   *
   * @param summary The completion summary claim from user or AI agent
   * @param graphData Graphify Tree-sitter knowledge graph data
   * @param useAi Whether to trigger Gemma 4 AI for semantic inspection
   * @param changedFunctions List of all functions detected as modified in the diff
   */
  async verifyAll(
    summary: string,
    graphData?: GraphifyGraphData,
    useAi: boolean = false,
    changedFunctions: ChangedFunction[] = []
  ): Promise<{
    claims: Claim[];
    findings: FindingEvidence[];
    untouchedCallers: UntouchedCaller[];
  }> {
    const rawClaims = this.extractClaimsFromSummary(summary);
    const claims: Claim[] = [];
    const allFindings: FindingEvidence[] = [];
    const allUntouchedCallers: UntouchedCaller[] = [];

    // Track symbols that have been checked via user claims to avoid duplicates
    const checkedSymbols = new Set<string>();

    // 1. Evaluate explicit claims from summary
    for (let i = 0; i < rawClaims.length; i++) {
      const raw = rawClaims[i];
      if (raw.targetSymbol) {
        checkedSymbols.add(raw.targetSymbol);
      }
      const claimId = `claim-${i + 1}`;

      const { claim, findings, untouched } = await this.verifySingleClaim(
        claimId,
        raw,
        graphData,
        useAi
      );

      claims.push(claim);
      allFindings.push(...findings);
      allUntouchedCallers.push(...untouched);
    }

    // 2. Comprehensive check: Inspect EVERY modified function across all files in the diff.
    // If a function was modified and has callers that were NOT updated in the diff,
    // surface every untouched caller as an issue.
    for (const fn of changedFunctions) {
      if (checkedSymbols.has(fn.name)) continue;
      checkedSymbols.add(fn.name);

      const allCallSites = await this.detector.detectCallers(fn.name, graphData);
      const untouchedSites = allCallSites.filter(s => s.status === 'UNTOUCHED');

      if (untouchedSites.length > 0) {
        const claimId = `claim-fn-${claims.length + 1}`;
        for (const u of untouchedSites) {
          allUntouchedCallers.push({
            symbol: fn.name,
            caller: u.caller,
            file: u.file,
            line: u.line,
            snippet: u.snippet,
            isModified: false,
            status: 'UNTOUCHED',
          });

          allFindings.push({
            id: `ev-${claimId}-${allFindings.length + 1}`,
            claimText: `Verify all callers of modified function '${fn.name}'`,
            verdict: 'CONTRADICTED',
            filePath: u.file,
            lineNumber: u.line,
            snippet: u.snippet,
            callerName: u.caller,
            targetSymbol: fn.name,
            explanation: `Call to modified function '${fn.name}' in '${u.caller}' remains UNTOUCHED at line ${u.line}.`,
            source: 'deterministic',
            confidence: 1.0,
            validated: this.validateSnippet(u.file, u.line, u.snippet),
          });
        }

        claims.push({
          id: claimId,
          rawText: `Callers of modified function '${fn.name}' (${fn.file}:${fn.line}) updated`,
          targetSymbol: fn.name,
          type: 'callers_updated',
          status: 'CONTRADICTED',
          evidence: allFindings.filter(f => f.targetSymbol === fn.name),
          explanation: `Contradicted: Found ${untouchedSites.length} untouched caller(s) of '${fn.name}' across the repository.`,
        });
      } else if (allCallSites.length > 0) {
        const claimId = `claim-fn-${claims.length + 1}`;
        claims.push({
          id: claimId,
          rawText: `Callers of modified function '${fn.name}' (${fn.file}:${fn.line}) updated`,
          targetSymbol: fn.name,
          type: 'callers_updated',
          status: 'VERIFIED',
          evidence: [],
          explanation: `Verified: All ${allCallSites.length} caller(s) of '${fn.name}' were updated in git diff.`,
        });
      }
    }

    // Deduplicate untouched callers by file:line:symbol:caller
    const uniqueUntouched: UntouchedCaller[] = [];
    const seenUntouched = new Set<string>();
    for (const u of allUntouchedCallers) {
      const key = `${u.file}:${u.line}:${u.symbol}:${u.caller}`;
      if (!seenUntouched.has(key)) {
        seenUntouched.add(key);
        uniqueUntouched.push(u);
      }
    }

    return {
      claims,
      findings: allFindings,
      untouchedCallers: uniqueUntouched,
    };
  }

  /**
   * Evaluates a single parsed claim using AST call analysis, workspace scanning, and optional AI.
   *
   * @param claimId Unique identifier for this claim (e.g. 'claim-1')
   * @param claimRaw Raw extracted claim object
   * @param graphData Optional Graphify AST knowledge graph
   * @param useAi Whether to invoke Gemma 4 AI for semantic ambiguity analysis
   * @returns Claim evaluation result, accompanying findings evidence, and untouched callers
   */
  private async verifySingleClaim(
    claimId: string,
    claimRaw: ExtractedClaimRaw,
    graphData?: GraphifyGraphData,
    useAi: boolean = false
  ): Promise<{
    claim: Claim;
    findings: FindingEvidence[];
    untouched: UntouchedCaller[];
  }> {
    const findings: FindingEvidence[] = [];
    const untouched: UntouchedCaller[] = [];

    let status: ClaimVerdict = 'UNVERIFIABLE';
    let explanation = '';

    if (claimRaw.type === 'callers_updated' && claimRaw.targetSymbol) {
      const target = claimRaw.targetSymbol;
      const allCallSites = await this.detector.detectCallers(target, graphData);
      const untouchedSites = allCallSites.filter(s => s.status === 'UNTOUCHED');

      for (const u of untouchedSites) {
        untouched.push({
          symbol: target,
          caller: u.caller,
          file: u.file,
          line: u.line,
          snippet: u.snippet,
          isModified: false,
          status: 'UNTOUCHED',
        });
      }

      if (untouchedSites.length > 0) {
        status = 'CONTRADICTED';
        explanation = `Contradicted: Found ${untouchedSites.length} untouched caller(s) of '${target}' that were not updated in this change.`;

        for (const u of untouchedSites) {
          findings.push({
            id: `ev-${claimId}-${findings.length + 1}`,
            claimText: claimRaw.rawText,
            verdict: 'CONTRADICTED',
            filePath: u.file,
            lineNumber: u.line,
            snippet: u.snippet,
            callerName: u.caller,
            targetSymbol: target,
            explanation: `Call to '${target}' in function '${u.caller}' remains UNTOUCHED at line ${u.line}.`,
            source: 'deterministic',
            confidence: 1.0,
            validated: this.validateSnippet(u.file, u.line, u.snippet),
          });
        }
      } else if (allCallSites.length > 0) {
        status = 'VERIFIED';
        explanation = `Verified: All ${allCallSites.length} caller(s) of '${target}' were updated in git diff. No untouched callers remain.`;

        const primaryUpdated = allCallSites[0];
        findings.push({
          id: `ev-${claimId}-${findings.length + 1}`,
          claimText: claimRaw.rawText,
          verdict: 'VERIFIED',
          filePath: primaryUpdated.file,
          lineNumber: primaryUpdated.line,
          snippet: primaryUpdated.snippet,
          callerName: primaryUpdated.caller,
          targetSymbol: target,
          explanation: `All callers (${allCallSites.map(c => c.caller).join(', ')}) were updated in git changes.`,
          source: 'deterministic',
          confidence: 1.0,
          validated: this.validateSnippet(primaryUpdated.file, primaryUpdated.line, primaryUpdated.snippet),
        });
      } else {
        status = 'UNVERIFIABLE';
        explanation = `Unverifiable: No callers of '${target}' found in the codebase to evaluate claim.`;
      }

      // If AI investigation is enabled, also invoke Gemma 4 to investigate caller updates
      if (useAi && this.aiService.isConfigured()) {
        const aiResult = await this.aiService.investigateClaim(
          claimRaw.rawText,
          this.gitChanges,
          this.repoPath
        );
        if (aiResult.file && aiResult.line && aiResult.evidenceSnippet) {
          findings.push({
            id: `ev-${claimId}-${findings.length + 1}`,
            claimText: claimRaw.rawText,
            verdict: aiResult.verdict,
            filePath: aiResult.file,
            lineNumber: aiResult.line,
            snippet: aiResult.evidenceSnippet,
            targetSymbol: target,
            explanation: `[Gemma 4 Investigation] ${aiResult.explanation}`,
            source: 'ai',
            confidence: aiResult.confidence,
            validated: this.validateSnippet(aiResult.file, aiResult.line, aiResult.evidenceSnippet),
          });
        }
      }
    } else if (claimRaw.type === 'reference_removed' && claimRaw.targetSymbol) {
      const target = claimRaw.targetSymbol;
      const occurrences = this.findReferencesInWorkspace(target);

      if (occurrences.length > 0) {
        status = 'CONTRADICTED';
        explanation = `Contradicted: Found ${occurrences.length} remaining reference(s) to '${target}' in codebase.`;

        for (const occ of occurrences) {
          findings.push({
            id: `ev-${claimId}-${findings.length + 1}`,
            claimText: claimRaw.rawText,
            verdict: 'CONTRADICTED',
            filePath: occ.file,
            lineNumber: occ.line,
            snippet: occ.snippet,
            targetSymbol: target,
            explanation: `Remaining reference to '${target}' found at line ${occ.line}.`,
            source: 'deterministic',
            confidence: 1.0,
            validated: this.validateSnippet(occ.file, occ.line, occ.snippet),
          });
        }
      } else {
        // Verify git diff actually contains changes/deletions mentioning the target
        const diffMentionsTarget = this.gitChanges.some(c =>
          c.diffHunks.some(h => h.content.includes(target))
        );

        if (diffMentionsTarget) {
          status = 'VERIFIED';
          explanation = `Verified: References to '${target}' were deleted in git diff and zero references remain in the working tree.`;
        } else {
          status = 'UNVERIFIABLE';
          explanation = `Unverifiable: Symbol '${target}' does not appear in git changes. Cannot verify removal.`;
        }
      }

      if (useAi && this.aiService.isConfigured()) {
        const aiResult = await this.aiService.investigateClaim(
          claimRaw.rawText,
          this.gitChanges,
          this.repoPath
        );
        if (aiResult.file && aiResult.line && aiResult.evidenceSnippet) {
          findings.push({
            id: `ev-${claimId}-${findings.length + 1}`,
            claimText: claimRaw.rawText,
            verdict: aiResult.verdict,
            filePath: aiResult.file,
            lineNumber: aiResult.line,
            snippet: aiResult.evidenceSnippet,
            targetSymbol: target,
            explanation: `[Gemma 4 Investigation] ${aiResult.explanation}`,
            source: 'ai',
            confidence: aiResult.confidence,
            validated: this.validateSnippet(aiResult.file, aiResult.line, aiResult.evidenceSnippet),
          });
        }
      }
    } else if (claimRaw.type === 'no_breaking_changes') {
      // Deterministic check: check if any function signature in git changes added parameters
      const signatureChanges = this.findSignatureModificationsInDiff();
      if (signatureChanges.length > 0) {
        status = 'AT RISK';
        explanation = `At Risk: Signature changes detected in: ${signatureChanges.map(s => s.symbol).join(', ')}. Parameter additions may break existing callers.`;

        for (const sig of signatureChanges) {
          findings.push({
            id: `ev-${claimId}-${findings.length + 1}`,
            claimText: claimRaw.rawText,
            verdict: 'AT RISK',
            filePath: sig.file,
            lineNumber: sig.line,
            snippet: sig.snippet,
            targetSymbol: sig.symbol,
            explanation: `Function signature was modified; verify whether callers were also updated or if default parameter values were supplied.`,
            source: 'deterministic',
            confidence: 0.85,
            validated: this.validateSnippet(sig.file, sig.line, sig.snippet),
          });
        }

        // If AI is enabled and configured, run Gemma 4 investigation on the breaking change
        if (useAi && this.aiService.isConfigured()) {
          const aiResult = await this.aiService.investigateClaim(
            claimRaw.rawText,
            this.gitChanges,
            this.repoPath
          );
          if (aiResult.verdict === 'CONTRADICTED' || aiResult.verdict === 'AT RISK') {
            status = aiResult.verdict;
            explanation = `[Gemma 4 Investigation] ${aiResult.explanation}`;
          }
          if (aiResult.file && aiResult.line && aiResult.evidenceSnippet) {
            findings.push({
              id: `ev-${claimId}-${findings.length + 1}`,
              claimText: claimRaw.rawText,
              verdict: aiResult.verdict,
              filePath: aiResult.file,
              lineNumber: aiResult.line,
              snippet: aiResult.evidenceSnippet,
              targetSymbol: signatureChanges[0]?.symbol,
              explanation: aiResult.explanation,
              source: 'ai',
              confidence: aiResult.confidence,
              validated: this.validateSnippet(aiResult.file, aiResult.line, aiResult.evidenceSnippet),
            });
          }
        }
      } else {
        status = 'VERIFIED';
        explanation = `Verified: No breaking function signature modifications found in git diff.`;
      }
    } else {
      // General or ambiguous claim
      if (useAi && this.aiService.isConfigured()) {
        const aiResult = await this.aiService.investigateClaim(
          claimRaw.rawText,
          this.gitChanges,
          this.repoPath
        );

        status = aiResult.verdict;
        explanation = `[AI Investigation] ${aiResult.explanation}`;

        if (aiResult.evidenceSnippet && aiResult.file && aiResult.line) {
          const isValid = this.validateSnippet(aiResult.file, aiResult.line, aiResult.evidenceSnippet);
          findings.push({
            id: `ev-${claimId}-1`,
            claimText: claimRaw.rawText,
            verdict: aiResult.verdict,
            filePath: aiResult.file,
            lineNumber: aiResult.line,
            snippet: aiResult.evidenceSnippet,
            explanation: aiResult.explanation,
            source: 'ai',
            confidence: aiResult.confidence,
            validated: isValid,
          });
        }
      } else {
        status = 'UNVERIFIABLE';
        explanation = `Ambiguous claim without direct syntactic pattern. AI investigation not enabled or API key not configured; marked as uncertain.`;
      }
    }

    const claim: Claim = {
      id: claimId,
      rawText: claimRaw.rawText,
      targetSymbol: claimRaw.targetSymbol,
      type: claimRaw.type,
      status,
      evidence: findings,
      explanation,
    };

    return { claim, findings, untouched };
  }

  /**
   * Validates whether a given code snippet actually exists in the target source file on disk.
   *
   * @param relFile Relative path to the source file
   * @param line 1-based line number of the snippet
   * @param snippet Code snippet to verify
   * @returns true if the file exists and contains the snippet content
   */
  private validateSnippet(relFile: string, line: number, snippet: string): boolean {
    try {
      const absFile = path.resolve(this.repoPath, relFile);
      if (!fs.existsSync(absFile)) return false;
      const content = fs.readFileSync(absFile, 'utf8');
      const firstSnippetLine = snippet.trim().split('\n')[0].trim();
      return content.includes(firstSnippetLine);
    } catch {
      return false;
    }
  }

  /**
   * Scans all supported source files in the repository workspace for references to a symbol.
   *
   * @param targetSymbol Identifier to search for across files
   * @returns Array of matches with relative file path, line number, and context snippet
   */
  private findReferencesInWorkspace(targetSymbol: string): Array<{ file: string; line: number; snippet: string }> {
    const results: Array<{ file: string; line: number; snippet: string }> = [];
    const sourceFiles = this.findSourceFiles(this.repoPath);

    for (const file of sourceFiles) {
      const absPath = path.join(this.repoPath, file);
      if (!fs.existsSync(absPath)) continue;
      const content = fs.readFileSync(absPath, 'utf8');
      const lines = content.split('\n');

      const regex = new RegExp(`\\b${escapeRegExp(targetSymbol)}\\b`);
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          const start = Math.max(0, i - 1);
          const end = Math.min(lines.length, i + 2);
          results.push({
            file,
            line: i + 1,
            snippet: lines.slice(start, end).join('\n'),
          });
        }
      }
    }

    return results;
  }

  /**
   * Inspects Git diff hunks to detect function signature modifications that added parameters.
   *
   * @returns Array of detected signature modifications with file, line, symbol, and snippet
   */
  private findSignatureModificationsInDiff(): Array<{ file: string; line: number; symbol: string; snippet: string }> {
    const results: Array<{ file: string; line: number; symbol: string; snippet: string }> = [];

    for (const change of this.gitChanges) {
      for (const hunk of change.diffHunks) {
        const hunkLines = hunk.content.split('\n');
        for (const line of hunkLines) {
          if (line.startsWith('+') && !line.startsWith('+++')) {
            const defMatch = line.match(/^\+\s*(?:def|function)\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)/);
            if (defMatch) {
              results.push({
                file: change.path,
                line: hunk.newStart,
                symbol: defMatch[1],
                snippet: line.slice(1).trim(),
              });
            }
          }
        }
      }
    }

    return results;
  }

  /**
   * Recursively traverses repository directory to discover source code files,
   * ignoring build artifacts, caches, and dependency folders.
   *
   * @param dir Directory to traverse
   * @param baseDir Base root directory for computing relative paths
   * @returns Array of relative source file paths
   */
  private findSourceFiles(dir: string, baseDir: string = dir): string[] {
    const files: string[] = [];
    const validExts = new Set(['.py', '.js', '.jsx', '.ts', '.tsx', '.go', '.rs', '.java']);
    const ignoreDirs = new Set(['.git', 'node_modules', '.next', 'dist', 'graphify-out', '__pycache__', '.venv']);

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!ignoreDirs.has(entry.name)) {
            files.push(...this.findSourceFiles(path.join(dir, entry.name), baseDir));
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (validExts.has(ext)) {
            files.push(path.relative(baseDir, path.join(dir, entry.name)).replace(/\\/g, '/'));
          }
        }
      }
    } catch {
      // Ignore read errors
    }
    return files;
  }
}

/**
 * Escapes special regex characters in a raw string literal.
 *
 * @param string Raw string to escape
 * @returns Regex-safe string pattern
 */
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

