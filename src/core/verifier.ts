import fs from 'node:fs';
import path from 'node:path';
import {
  Claim,
  ClaimVerdict,
  FindingEvidence,
  GitFileChange,
  UntouchedCaller,
} from './types';
import { MissedCallerDetector } from './detector';
import { GraphifyGraphData } from './graphify';
import { AIService } from './ai';

export interface ExtractedClaimRaw {
  rawText: string;
  type: Claim['type'];
  targetSymbol?: string;
  condition?: string;
}

export class ClaimVerifier {
  private repoPath: string;
  private gitChanges: GitFileChange[];
  private detector: MissedCallerDetector;
  private aiService: AIService;

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
   * Verify all extracted claims against code changes and codebase state
   */
  async verifyAll(
    summary: string,
    graphData?: GraphifyGraphData,
    useAi: boolean = false
  ): Promise<{
    claims: Claim[];
    findings: FindingEvidence[];
    untouchedCallers: UntouchedCaller[];
  }> {
    const rawClaims = this.extractClaimsFromSummary(summary);
    const claims: Claim[] = [];
    const allFindings: FindingEvidence[] = [];
    const allUntouchedCallers: UntouchedCaller[] = [];

    for (let i = 0; i < rawClaims.length; i++) {
      const raw = rawClaims[i];
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

    return {
      claims,
      findings: allFindings,
      untouchedCallers: allUntouchedCallers,
    };
  }

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
        status = 'VERIFIED';
        explanation = `Verified: No callers of '${target}' exist in the codebase.`;
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
        status = 'VERIFIED';
        explanation = `Verified: All references to '${target}' have been removed from the repository.`;
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

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

