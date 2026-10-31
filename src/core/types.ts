import { z } from 'zod';

export const ClaimVerdictSchema = z.enum([
  'UPDATED',
  'UNTOUCHED',
  'CONTRADICTED',
  'VERIFIED',
  'AT RISK',
  'UNVERIFIABLE'
]);
export type ClaimVerdict = z.infer<typeof ClaimVerdictSchema>;

export const FindingEvidenceSchema = z.object({
  id: z.string(),
  claimText: z.string(),
  verdict: ClaimVerdictSchema,
  filePath: z.string(),
  lineNumber: z.number(),
  endLineNumber: z.number().optional(),
  snippet: z.string(),
  callerName: z.string().optional(),
  targetSymbol: z.string().optional(),
  explanation: z.string(),
  source: z.enum(['deterministic', 'ai']),
  confidence: z.number().min(0).max(1),
  validated: z.boolean().default(true),
});
export type FindingEvidence = z.infer<typeof FindingEvidenceSchema>;

export const ClaimTypeSchema = z.enum([
  'callers_updated',
  'reference_removed',
  'no_breaking_changes',
  'signature_change',
  'general'
]);
export type ClaimType = z.infer<typeof ClaimTypeSchema>;

export const ClaimSchema = z.object({
  id: z.string(),
  rawText: z.string(),
  targetSymbol: z.string().optional(),
  type: ClaimTypeSchema,
  status: ClaimVerdictSchema,
  evidence: z.array(FindingEvidenceSchema),
  explanation: z.string(),
});
export type Claim = z.infer<typeof ClaimSchema>;

export const UntouchedCallerSchema = z.object({
  symbol: z.string(),
  caller: z.string(),
  file: z.string(),
  line: z.number(),
  snippet: z.string(),
  isModified: z.boolean(),
  status: z.enum(['UNTOUCHED', 'UPDATED', 'UNKNOWN']),
});
export type UntouchedCaller = z.infer<typeof UntouchedCallerSchema>;

export const DiffHunkSchema = z.object({
  oldStart: z.number(),
  oldLines: z.number(),
  newStart: z.number(),
  newLines: z.number(),
  content: z.string(),
});
export type DiffHunk = z.infer<typeof DiffHunkSchema>;

export const GitFileChangeSchema = z.object({
  path: z.string(),
  status: z.enum(['modified', 'added', 'deleted', 'untracked']),
  insertions: z.number(),
  deletions: z.number(),
  diffHunks: z.array(DiffHunkSchema),
  modifiedLines: z.array(z.number()),
});
export type GitFileChange = z.infer<typeof GitFileChangeSchema>;

export const GraphifyStatusSchema = z.object({
  available: z.boolean(),
  version: z.string().optional(),
  executed: z.boolean(),
  nodeCount: z.number().optional(),
  edgeCount: z.number().optional(),
  error: z.string().optional(),
  coverageWarning: z.string().optional(),
});
export type GraphifyStatus = z.infer<typeof GraphifyStatusSchema>;

export const VerificationRequestSchema = z.object({
  repoPath: z.string().min(1, 'Repository path is required'),
  baseRevision: z.string().default('HEAD~1'),
  summary: z.string().min(1, 'Summary of claims is required'),
  strict: z.boolean().default(false),
  useAi: z.boolean().default(false),
});
export type VerificationRequest = z.infer<typeof VerificationRequestSchema>;

export const VerificationResultSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  repoPath: z.string(),
  baseRevision: z.string(),
  headRevision: z.string(),
  summary: z.string(),
  overallVerdict: z.enum(['PASSED', 'FAILED', 'WARNING']),
  strict: z.boolean(),
  claims: z.array(ClaimSchema),
  findings: z.array(FindingEvidenceSchema),
  untouchedCallers: z.array(UntouchedCallerSchema),
  gitChanges: z.array(GitFileChangeSchema),
  graphify: GraphifyStatusSchema,
  aiStatus: z.object({
    used: z.boolean(),
    model: z.string().optional(),
    notes: z.string().optional(),
  }),
  stats: z.object({
    totalClaims: z.number(),
    verified: z.number(),
    contradicted: z.number(),
    atRisk: z.number(),
    untouchedCallers: z.number(),
  }),
});
export type VerificationResult = z.infer<typeof VerificationResultSchema>;

