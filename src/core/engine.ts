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

    // 2. Run Graphify to construct code knowledge graph
    const graphResult = await this.graphService.generateGraph(gitResult.repoPath);

    // 3. Initialize detector & verifier
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

    // 4. Verify claims against code changes
    const { claims, findings, untouchedCallers } = await verifier.verifyAll(
      request.summary,
      graphResult.graphData,
      request.useAi
    );

    // 5. Calculate statistics & overall verdict
    const verifiedCount = claims.filter(c => c.status === 'VERIFIED' || c.status === 'UPDATED').length;
    const contradictedCount = claims.filter(c => c.status === 'CONTRADICTED' || c.status === 'UNTOUCHED').length;
    const atRiskCount = claims.filter(c => c.status === 'AT RISK').length;
    const untouchedCallersCount = untouchedCallers.length;

    let overallVerdict: 'PASSED' | 'FAILED' | 'WARNING' = 'PASSED';
    if (contradictedCount > 0 || untouchedCallersCount > 0) {
      overallVerdict = 'FAILED';
    } else if (atRiskCount > 0 || (request.strict && !graphResult.status.executed)) {
      overallVerdict = 'WARNING';
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
      summary: request.summary,
      overallVerdict,
      strict: request.strict,
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
}

