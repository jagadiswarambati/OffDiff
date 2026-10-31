/**
 * @file git.ts
 * @description Git inspection service for OffDiff. Handles Git repository discovery,
 * revision validation, remote GitHub repository cloning and caching, diff parsing,
 * modified line detection, untracked file handling, and commit metadata extraction.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import { GitFileChange, DiffHunk } from './types';

const execFileAsync = promisify(execFile);

/**
 * Result of inspecting a Git repository at a specific base revision.
 */
export interface GitInspectionResult {
  /** Local resolved directory path on filesystem */
  repoPath: string;
  /** Resolved 8-character base revision commit hash */
  baseRevision: string;
  /** Current HEAD commit hash or 'WORKING_TREE' */
  headRevision: string;
  /** Subject line of the latest commit at HEAD */
  commitSubject?: string;
  /** Full commit message body */
  commitMessage?: string;
  /** Author name of latest commit */
  commitAuthor?: string;
  /** ISO/Git date string of latest commit */
  commitDate?: string;
  /** Structured changes per file */
  changes: GitFileChange[];
  /** List of modified file paths */
  modifiedFiles: string[];
  /** List of newly added file paths */
  addedFiles: string[];
  /** List of deleted file paths */
  deletedFiles: string[];
  /** List of untracked file paths in working tree */
  untrackedFiles: string[];
  /** Raw unified diff output from git diff */
  rawDiff: string;
}

/**
 * Execute a Git command safely with standard maxBuffer and error handling.
 *
 * @param args Git command line arguments (e.g. ['status', '--porcelain'])
 * @param cwd Working directory for the git execution
 * @returns Trimmed stdout string
 */
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

/**
 * Checks whether an input string represents a remote Git URL or GitHub URL.
 *
 * @param input Path or URL string
 * @returns true if input is an HTTP(S), SSH, or GitHub remote URL
 */
export function isRemoteGitUrl(input: string): boolean {
  if (!input || typeof input !== 'string') return false;
  const trimmed = input.trim();
  if (path.isAbsolute(trimmed) || trimmed.startsWith('.' + path.sep) || trimmed.startsWith('./') || trimmed.startsWith('.\\')) {
    return false;
  }
  return /^(https?:\/\/|git@|github\.com\/)/i.test(trimmed) || (trimmed.endsWith('.git') && !fs.existsSync(trimmed));
}

/**
 * Normalizes user-supplied Git URLs into full HTTPS URLs.
 * Handles cases like 'github.com/owner/repo' -> 'https://github.com/owner/repo'.
 */
export function normalizeGitUrl(input: string): string {
  const trimmed = input.trim();
  if (/^github\.com\//i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

/**
 * Ensures the target repository exists locally on disk.
 * If given a remote GitHub or Git URL, clones it into a local cache directory (.offdiff-cache/repos/)
 * and runs `git fetch` to keep commits updated.
 *
 * @param repoPathOrUrl Local path or remote Git URL
 * @returns Absolute local directory path of the repository
 */
export async function ensureRepositoryPath(repoPathOrUrl: string): Promise<string> {
  const trimmed = repoPathOrUrl.trim();
  if (!isRemoteGitUrl(trimmed)) {
    const resolvedPath = path.resolve(trimmed);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Directory does not exist: ${resolvedPath}`);
    }
    return resolvedPath;
  }

  const normalizedUrl = normalizeGitUrl(trimmed);
  const cacheBase = path.resolve(process.cwd(), '.offdiff-cache', 'repos');
  if (!fs.existsSync(cacheBase)) {
    fs.mkdirSync(cacheBase, { recursive: true });
  }

  const safeName = normalizedUrl
    .replace(/^https?:\/\//i, '')
    .replace(/^git@/i, '')
    .replace(/\.git$/i, '')
    .replace(/[^a-zA-Z0-9_.-]/g, '_');

  const targetDir = path.join(cacheBase, safeName);

  if (fs.existsSync(targetDir)) {
    try {
      const isRepo = await runGit(['rev-parse', '--is-inside-work-tree'], targetDir);
      if (isRepo === 'true') {
        try {
          await runGit(['fetch', '--all'], targetDir);
        } catch {
          // If offline or fetch fails, existing clone is still usable
        }
        return targetDir;
      }
    } catch {
      try {
        fs.rmSync(targetDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  try {
    await execFileAsync('git', ['clone', normalizedUrl, targetDir], {
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  } catch (err: unknown) {
    const error = err as Error & { stderr?: string };
    const stderr = error.stderr?.trim() || error.message;
    if (stderr.includes('Repository not found') || stderr.includes('not found')) {
      throw new Error(
        `Failed to clone GitHub repository '${normalizedUrl}': Repository not found or private. Please check that the URL is spelled correctly and the repository is publicly accessible.`
      );
    }
    throw new Error(`Failed to clone remote repository '${normalizedUrl}': ${stderr}`);
  }

  return targetDir;
}

/**
 * Inspects a Git repository at a specified base revision.
 * Evaluates the working tree and diff hunks, verifies commits, captures untracked files,
 * and extracts latest commit metadata.
 *
 * @param repoPath Path to local git directory or remote GitHub URL
 * @param baseRevision Base commit revision to compare against (default 'HEAD~1')
 * @returns Structured Git inspection result
 */
export async function inspectGitRepository(
  repoPath: string,
  baseRevision: string = 'HEAD~1'
): Promise<GitInspectionResult> {
  const resolvedPath = await ensureRepositoryPath(repoPath);

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
    baseHash = await runGit(['rev-parse', '--verify', `${baseRevision}^{commit}`], resolvedPath);
  } catch {
    // If default HEAD~1 was requested on a repository with only one commit, fallback to root commit
    if (baseRevision === 'HEAD~1') {
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
    } else {
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

  // Extract latest commit info for context
  let commitSubject = '';
  let commitMessage = '';
  let commitAuthor = '';
  let commitDate = '';
  try {
    commitSubject = await runGit(['log', '-1', '--pretty=%s', 'HEAD'], resolvedPath);
    commitMessage = await runGit(['log', '-1', '--pretty=%B', 'HEAD'], resolvedPath);
    commitAuthor = await runGit(['log', '-1', '--pretty=%an', 'HEAD'], resolvedPath);
    commitDate = await runGit(['log', '-1', '--pretty=%cd', 'HEAD'], resolvedPath);
  } catch {
    // ignore if empty or detached
  }

  const modifiedFiles = changes.filter(c => c.status === 'modified').map(c => c.path);
  const addedFiles = changes.filter(c => c.status === 'added').map(c => c.path);
  const deletedFiles = changes.filter(c => c.status === 'deleted').map(c => c.path);

  return {
    repoPath: resolvedPath,
    baseRevision: baseHash.slice(0, 8),
    headRevision: headHash.slice(0, 8),
    commitSubject: commitSubject.trim(),
    commitMessage: commitMessage.trim(),
    commitAuthor: commitAuthor.trim(),
    commitDate: commitDate.trim(),
    changes,
    modifiedFiles,
    addedFiles,
    deletedFiles,
    untrackedFiles,
    rawDiff,
  };
}

/**
 * Parses raw unified git diff output into structured file changes,
 * line numbers, insertions, deletions, and diff hunks.
 *
 * @param rawDiff Output from git diff
 * @param untrackedFiles Optional list of untracked files to incorporate
 * @returns Array of structured GitFileChange objects
 */
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

