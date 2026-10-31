/**
 * @file types.ts
 * @description Core Zod schemas and TypeScript type definitions for OffDiff.
 * Defines the contract between Git inspection, AST code-graph analysis,
 * claim verification, AI semantic investigation, CLI gate, and Web Dashboard.
 */

import { z } from 'zod';

/**
 * Possible verdicts for an individual completion claim or finding.
 */
export const ClaimVerdictSchema = z.enum([
  'UPDATED',       // Code symbol / caller was modified in the diff
  'UNTOUCHED',     // Code symbol / caller exists in codebase but was untouched in diff
  'CONTRADICTED',  // Code changes contradict the completion claim (e.g. missed callers)
  'VERIFIED',      // All evidence fully supports the completion claim
  'AT RISK',       // Potential breaking change or unverified signature change
  'UNVERIFIABLE',  // Claim cannot be verified (e.g. symbol not found or ambiguous)
]);
export type ClaimVerdict = z.infer<typeof ClaimVerdictSchema>;

/**
 * Concrete source code evidence supporting or contradicting a claim.
 */
export const FindingEvidenceSchema = z.object({
  /** Unique finding identifier */
  id: z.string(),
  /** The claim text associated with this finding */
  claimText: z.string(),
  /** The verdict evaluated for this piece of evidence */
  verdict: ClaimVerdictSchema,
  /** Relative repository file path containing the evidence */
  filePath: z.string(),
  /** Line number where the symbol or caller is located */
  lineNumber: z.number(),
  /** Optional end line number for multi-line snippets */
  endLineNumber: z.number().optional(),
  /** Verifiable source code snippet extracted from disk */
  snippet: z.string(),
  /** Optional caller function name */
  callerName: z.string().optional(),
  /** Optional target function or variable name */
  targetSymbol: z.string().optional(),
  /** Human-readable explanation of why this finding was produced */
  explanation: z.string(),
  /** Whether the finding was generated deterministically or via AI */
  source: z.enum(['deterministic', 'ai']),
  /** Confidence score between 0.0 and 1.0 */
  confidence: z.number().min(0).max(1),
  /** Whether the snippet was verified to exist verbatim in the source file */
  validated: z.boolean().default(true),
});
export type FindingEvidence = z.infer<typeof FindingEvidenceSchema>;

/**
 * Categories of completion claims made by coding agents.
 */
export const ClaimTypeSchema = z.enum([
  'callers_updated',     // "Updated all callers of X"
  'reference_removed',   // "Removed every reference to Y"
  'no_breaking_changes', // "No breaking changes / backwards compatible"
  'signature_change',    // "Added parameter Z to function X"
  'general',             // General commit message or unclassified claim
]);
export type ClaimType = z.infer<typeof ClaimTypeSchema>;

/**
 * An individual completion claim evaluated by OffDiff.
 */
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

/**
 * Represents a caller function that should have been updated but remains untouched.
 */
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

/**
 * Represents a function declaration modified in the Git diff.
 */
export const ChangedFunctionSchema = z.object({
  name: z.string(),
  file: z.string(),
  line: z.number(),
  oldSignature: z.string().optional(),
  newSignature: z.string().optional(),
  snippet: z.string(),
});
export type ChangedFunction = z.infer<typeof ChangedFunctionSchema>;

/**
 * A caller-callee dependency relationship extracted from Graphify or fallback AST.
 */
export const DependencyRelationshipSchema = z.object({
  caller: z.string(),
  callee: z.string(),
  relation: z.string(),
  file: z.string(),
  line: z.number(),
  status: z.enum(['CHANGED', 'UNCHANGED']),
  source: z.enum(['graphify', 'ast_fallback']),
});
export type DependencyRelationship = z.infer<typeof DependencyRelationshipSchema>;

/**
 * A Git diff hunk within a modified file.
 */
export const DiffHunkSchema = z.object({
  oldStart: z.number(),
  oldLines: z.number(),
  newStart: z.number(),
  newLines: z.number(),
  content: z.string(),
});
export type DiffHunk = z.infer<typeof DiffHunkSchema>;

/**
 * A file changed in the repository working tree or revision range.
 */
export const GitFileChangeSchema = z.object({
  path: z.string(),
  status: z.enum(['modified', 'added', 'deleted', 'untracked']),
  insertions: z.number(),
  deletions: z.number(),
  diffHunks: z.array(DiffHunkSchema),
  modifiedLines: z.array(z.number()),
});
export type GitFileChange = z.infer<typeof GitFileChangeSchema>;

/**
 * Execution status and diagnostics for Graphify AST code-graph generation.
 */
export const GraphifyStatusSchema = z.object({
  available: z.boolean(),
  version: z.string().optional(),
  executed: z.boolean(),
  exitCode: z.number().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  graphJsonPath: z.string().optional(),
  nodeCount: z.number().optional(),
  edgeCount: z.number().optional(),
  error: z.string().optional(),
  coverageWarning: z.string().optional(),
});
export type GraphifyStatus = z.infer<typeof GraphifyStatusSchema>;

/**
 * Input request parameters to execute an OffDiff verification run.
 */
export const VerificationRequestSchema = z.object({
  repoPath: z.string().min(1, 'Repository path is required'),
  baseRevision: z.string().default('HEAD~1'),
  summary: z.string().optional().default(''),
  strict: z.boolean().default(false),
  useAi: z.boolean().default(false),
});
export type VerificationRequest = z.input<typeof VerificationRequestSchema>;
export type ParsedVerificationRequest = z.infer<typeof VerificationRequestSchema>;

/**
 * Complete, structured verification report output by OffDiffEngine.
 */
export const VerificationResultSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  repoPath: z.string(),
  baseRevision: z.string(),
  headRevision: z.string(),
  summary: z.string(),
  commitInfo: z.object({
    subject: z.string().optional(),
    message: z.string().optional(),
    author: z.string().optional(),
    date: z.string().optional(),
  }).optional(),
  overallVerdict: z.enum(['PASSED', 'FAILED', 'WARNING']),
  strict: z.boolean(),
  suggestedAction: z.string(),
  changedFunctions: z.array(ChangedFunctionSchema),
  dependencyRelationships: z.array(DependencyRelationshipSchema),
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
