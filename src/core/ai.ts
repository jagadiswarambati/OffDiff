import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { ClaimVerdict, GitFileChange } from './types';

// Ensure .env.local and .env are loaded in both CLI and Node execution contexts
try {
  dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
  dotenv.config({ path: path.resolve(process.cwd(), '.env') });
} catch {
  // Ignore dotenv load errors
}

export interface AIInvestigationResult {
  verdict: ClaimVerdict;
  explanation: string;
  confidence: number;
  modelUsed: string;
  file?: string;
  line?: number;
  evidenceSnippet?: string;
}

export class AIService {
  private apiKey?: string;
  private rawModelName: string;

  constructor(customKey?: string, customModel?: string) {
    this.apiKey =
      customKey ||
      process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_API_KEY ||
      undefined;

    this.rawModelName = customModel || process.env.OFFDIFF_AI_MODEL || 'gemma-4-26b-a4b-it';
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  /**
   * Resolve model identifier to the exact API model ID.
   * If shorthand 'gemma-4' or 'gemma4' is given, resolve to the verified working 'gemma-4-26b-a4b-it'.
   */
  getModelName(): string {
    const clean = this.rawModelName.trim().replace(/^models\//, '');
    if (clean === 'gemma-4' || clean === 'gemma4') {
      return 'gemma-4-26b-a4b-it';
    }
    return clean;
  }

  /**
   * Verify API connectivity and model availability
   */
  async checkHealth(): Promise<{ available: boolean; model: string; error?: string }> {
    if (!this.isConfigured()) {
      return {
        available: false,
        model: this.getModelName(),
        error: 'No GEMINI_API_KEY or GOOGLE_API_KEY found in .env.local or environment.',
      };
    }

    const modelToUse = this.getModelName();
    try {
      const { GoogleGenAI } = await import('@google/genai');
      const ai = new GoogleGenAI({ apiKey: this.apiKey! });

      const response = await ai.models.generateContent({
        model: modelToUse,
        contents: 'Ping',
      });

      if (response && response.text) {
        return { available: true, model: modelToUse };
      }
      return { available: false, model: modelToUse, error: 'Empty response returned from model' };
    } catch (err: unknown) {
      const error = err as Error;
      return {
        available: false,
        model: modelToUse,
        error: `AI Model '${modelToUse}' error: ${error.message}`,
      };
    }
  }

  /**
   * Investigate ambiguous or semantic claims using the verified Gemma 4 model
   */
  async investigateClaim(
    claimText: string,
    gitChanges: GitFileChange[],
    repoPath: string
  ): Promise<AIInvestigationResult> {
    const modelToUse = this.getModelName();

    if (!this.isConfigured()) {
      return {
        verdict: 'UNVERIFIABLE',
        explanation: 'AI investigation unavailable (no API key configured). Deterministic analysis used.',
        confidence: 0,
        modelUsed: modelToUse,
      };
    }

    try {
      const { GoogleGenAI } = await import('@google/genai');
      const ai = new GoogleGenAI({ apiKey: this.apiKey! });

      const diffSummary = gitChanges
        .map(c => `File: ${c.path} (${c.status}, +${c.insertions}/-${c.deletions})\n${c.diffHunks.map(h => h.content).join('\n')}`)
        .join('\n\n')
        .slice(0, 12000);

      const prompt = `You are OffDiff, an evidence-based code verification system.
An AI coding agent made the following completion claim:
"${claimText}"

Here is the Git diff of actual code changes:
${diffSummary}

Evaluate whether the Git diff and codebase support this claim.
Rules:
1. Classify the verdict as exactly one of: UPDATED, UNTOUCHED, CONTRADICTED, VERIFIED, AT RISK, UNVERIFIABLE.
2. Provide a clear, factual explanation based solely on the evidence.
3. If referencing code, provide the exact relative file path and line number, and an EXACT quotation of 1-3 lines from the source.
4. Output your response in valid JSON matching this schema:
{
  "verdict": "VERIFIED" | "CONTRADICTED" | "AT RISK" | "UNVERIFIABLE",
  "explanation": "...",
  "confidence": 0.0 to 1.0,
  "file": "path/to/file.py",
  "line": 1,
  "evidenceSnippet": "exact quoted snippet"
}`;

      const response = await ai.models.generateContent({
        model: modelToUse,
        contents: prompt,
      });

      const responseText = response.text || '';
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return {
          verdict: 'UNVERIFIABLE',
          explanation: `Model did not return structured JSON. Raw output: ${responseText.slice(0, 150)}`,
          confidence: 0.3,
          modelUsed: modelToUse,
        };
      }

      const parsed = JSON.parse(jsonMatch[0]);

      let validatedSnippet = parsed.evidenceSnippet;
      let isValidQuote = false;

      if (parsed.file && parsed.evidenceSnippet) {
        const absPath = path.resolve(repoPath, parsed.file);
        if (fs.existsSync(absPath)) {
          const fileContent = fs.readFileSync(absPath, 'utf8');
          const trimmedSnippet = parsed.evidenceSnippet.trim().split('\n')[0].trim();
          isValidQuote = fileContent.includes(trimmedSnippet);
        }
      }

      const validVerdicts: ClaimVerdict[] = ['VERIFIED', 'CONTRADICTED', 'AT RISK', 'UNVERIFIABLE', 'UPDATED', 'UNTOUCHED'];
      const verdict = validVerdicts.includes(parsed.verdict) ? (parsed.verdict as ClaimVerdict) : 'UNVERIFIABLE';

      return {
        verdict,
        explanation: parsed.explanation || 'Analyzed via Gemma 4 verification.',
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.85,
        modelUsed: modelToUse,
        file: parsed.file,
        line: typeof parsed.line === 'number' ? parsed.line : undefined,
        evidenceSnippet: isValidQuote ? validatedSnippet : undefined,
      };
    } catch (err: unknown) {
      const error = err as Error;
      return {
        verdict: 'UNVERIFIABLE',
        explanation: `AI investigation error (${modelToUse}): ${error.message}`,
        confidence: 0,
        modelUsed: modelToUse,
      };
    }
  }
}
