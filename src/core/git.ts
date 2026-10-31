import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import { GitFileChange, DiffHunk } from './types';

const execFileAsync = promisify(execFile);

export interface GitInspectionResult {
  repoPath: string;
  baseRevision: string;
  headRevision: string;
  changes: GitFileChange[];
  modifiedFiles: string[];
  addedFiles: string[];
  deletedFiles: string[];
  untrackedFiles: string[];
  rawDiff: string;
}

export async function runGit(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return stdout.trim();
  } catch (err: unknown) {
    const error = err as Error & { stderr?: string };
    const msg = error.stderr?.trim() || error.message;
    throw new Error(`Git error (git ${args.join(' ')}): ${msg}`);
  }
}

export async function inspectGitRepository(
  repoPath: string,
  baseRevision: string = 'HEAD~1'
): Promise<GitInspectionResult> {
  const resolvedPath = path.resolve(repoPath);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Directory does not exist: ${resolvedPath}`);
  }

  // Check if it's a git repo
  try {
    const isRepo = await runGit(['rev-parse', '--is-inside-work-tree'], resolvedPath);
    if (isRepo !== 'true') {
      throw new Error(`Not a git repository: ${resolvedPath}`);
    }
  } catch {
    throw new Error(`Directory is not a valid git repository: ${resolvedPath}`);
  }

  // Resolve base revision commit hash
  let baseHash: string;
  try {
    baseHash = await runGit(['rev-parse', '--verify', baseRevision], resolvedPath);
  } catch {
    // If base revision doesn't exist (e.g. initial commit HEAD~1), check git rev-list
    try {
      const commits = await runGit(['rev-list', '--max-parents=0', 'HEAD'], resolvedPath);
      const rootCommit = commits.split('\n')[0];
      if (rootCommit) {
        baseHash = rootCommit;
      } else {
        throw new Error(`Cannot resolve base revision '${baseRevision}'`);
      }
    } catch {
      throw new Error(`Invalid base revision: '${baseRevision}'`);
    }
  }

  // Get current HEAD commit hash
  let headHash = 'WORKING_TREE';
  try {
    headHash = await runGit(['rev-parse', 'HEAD'], resolvedPath);
  } catch {
    headHash = 'UNCOMMITTED';
  }

  // Check working tree status
  const statusOutput = await runGit(['status', '--porcelain=v1'], resolvedPath);
  const untrackedFiles: string[] = [];
  if (statusOutput) {
    for (const line of statusOutput.split('\n')) {
      const code = line.slice(0, 2);
      const file = line.slice(3).trim();
      if (code.includes('?')) {
        untrackedFiles.push(file);
      }
    }
  }

  // Get diff against base revision (including working tree changes!)
  // If working tree is clean or has changes, diff against working tree
  let rawDiff = '';
  try {
    rawDiff = await runGit(['diff', baseRevision], resolvedPath);
  } catch {
    rawDiff = '';
  }

  // Parse diff into structured files and hunks
  const changes = parseGitDiff(rawDiff, untrackedFiles);

  const modifiedFiles = changes.filter(c => c.status === 'modified').map(c => c.path);
  const addedFiles = changes.filter(c => c.status === 'added').map(c => c.path);
  const deletedFiles = changes.filter(c => c.status === 'deleted').map(c => c.path);

  return {
    repoPath: resolvedPath,
    baseRevision: baseHash.slice(0, 8),
    headRevision: headHash.slice(0, 8),
    changes,
    modifiedFiles,
    addedFiles,
    deletedFiles,
    untrackedFiles,
    rawDiff,
  };
}

export function parseGitDiff(rawDiff: string, untrackedFiles: string[] = []): GitFileChange[] {
  const files: GitFileChange[] = [];
  if (!rawDiff && untrackedFiles.length === 0) {
    return files;
  }

  const diffBlocks = rawDiff.split(/^diff --git /m).filter(Boolean);

  for (const block of diffBlocks) {
    const lines = block.split('\n');
    const headerMatch = lines[0].match(/a\/(.+?)\s+b\/(.+)/);
    const filePath = headerMatch ? headerMatch[2] : lines[0].split(' ')[1] || 'unknown';

    let status: 'modified' | 'added' | 'deleted' | 'untracked' = 'modified';
    if (block.includes('new file mode')) {
      status = 'added';
    } else if (block.includes('deleted file mode')) {
      status = 'deleted';
    }

    let insertions = 0;
    let deletions = 0;
    const diffHunks: DiffHunk[] = [];
    const modifiedLines: number[] = [];

    let currentHunk: DiffHunk | null = null;
    let currentNewCurLine = 0;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);

      if (hunkMatch) {
        if (currentHunk) {
          diffHunks.push(currentHunk);
        }
        const oldStart = parseInt(hunkMatch[1], 10);
        const oldLines = hunkMatch[2] ? parseInt(hunkMatch[2], 10) : 1;
        const newStart = parseInt(hunkMatch[3], 10);
        const newLines = hunkMatch[4] ? parseInt(hunkMatch[4], 10) : 1;

        currentNewCurLine = newStart;
        currentHunk = {
          oldStart,
          oldLines,
          newStart,
          newLines,
          content: line + '\n',
        };
      } else if (currentHunk) {
        currentHunk.content += line + '\n';
        if (line.startsWith('+') && !line.startsWith('+++')) {
          insertions++;
          modifiedLines.push(currentNewCurLine);
          currentNewCurLine++;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          deletions++;
        } else if (line.startsWith(' ')) {
          currentNewCurLine++;
        }
      }
    }

    if (currentHunk) {
      diffHunks.push(currentHunk);
    }

    files.push({
      path: filePath,
      status,
      insertions,
      deletions,
      diffHunks,
      modifiedLines: Array.from(new Set(modifiedLines)).sort((a, b) => a - b),
    });
  }

  // Include untracked files
  for (const untracked of untrackedFiles) {
    if (!files.some(f => f.path === untracked)) {
      files.push({
        path: untracked,
        status: 'untracked',
        insertions: 0,
        deletions: 0,
        diffHunks: [],
        modifiedLines: [],
      });
    }
  }

  return files;
}

