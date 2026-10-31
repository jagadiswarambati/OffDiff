import { NextRequest, NextResponse } from 'next/server';
import { inspectGitRepository } from '@/core/git';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const repo = searchParams.get('repo') || 'demo-repo';
    const base = searchParams.get('base') || 'HEAD~1';

    const gitResult = await inspectGitRepository(repo, base);

    // Formulate a suggested claim based on real commit and diff
    let suggestedClaim = gitResult.commitSubject || 'Code changes in recent commit';
    if (gitResult.modifiedFiles.length > 0) {
      const codeFiles = gitResult.modifiedFiles.filter(f => /\.(py|js|jsx|ts|tsx|go|rs)$/i.test(f));
      if (codeFiles.length > 0) {
        suggestedClaim = `${gitResult.commitSubject || `Updated ${codeFiles[0]}`}`;
      }
    }

    return NextResponse.json({
      repoPath: gitResult.repoPath,
      baseRevision: gitResult.baseRevision,
      headRevision: gitResult.headRevision,
      commitSubject: gitResult.commitSubject || '',
      commitMessage: gitResult.commitMessage || '',
      commitAuthor: gitResult.commitAuthor || '',
      commitDate: gitResult.commitDate || '',
      changedFiles: gitResult.changes.map(c => ({
        path: c.path,
        status: c.status,
        insertions: c.insertions,
        deletions: c.deletions,
      })),
      suggestedClaim,
    });
  } catch (err: unknown) {
    const error = err as Error;
    return NextResponse.json(
      { error: error.message || 'Failed to inspect repository' },
      { status: 500 }
    );
  }
}

