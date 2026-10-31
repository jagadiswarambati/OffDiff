/**
 * @file route.ts
 * @description API endpoint: POST /api/verify
 * Accepts verification requests from dashboard or external integrations,
 * parses input using Zod, executes the OffDiffEngine pipeline, and returns
 * structured JSON results with HTTP 200 (or HTTP 400/500 on error).
 */

import { NextRequest, NextResponse } from 'next/server';
import path from 'node:path';
import { OffDiffEngine } from '@/core/engine';
import { VerificationRequestSchema } from '@/core/types';
import { isRemoteGitUrl } from '@/core/git';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parseResult = VerificationRequestSchema.safeParse(body);

    if (!parseResult.success) {
      return NextResponse.json(
        { error: 'Invalid request', details: parseResult.error.format() },
        { status: 400 }
      );
    }

    const { repoPath, baseRevision, summary, strict, useAi } = parseResult.data;
    const resolvedRepo = isRemoteGitUrl(repoPath)
      ? repoPath
      : path.isAbsolute(repoPath)
      ? repoPath
      : path.resolve(process.cwd(), repoPath);

    const engine = new OffDiffEngine();
    const result = await engine.runVerification({
      repoPath: resolvedRepo,
      baseRevision,
      summary,
      strict,
      useAi,
    });

    return NextResponse.json(result);
  } catch (err: unknown) {
    const error = err as Error;
    return NextResponse.json(
      { error: error.message || 'Verification failed' },
      { status: 500 }
    );
  }
}

