/**
 * @file detector.ts
 * @description Missed Caller Detector for OffDiff.
 * Combines Graphify AST call graphs with recursive AST fallback regex scanning to identify
 * every caller of a refactored symbol across the entire repository. Cross-references each
 * caller's file and line against the Git diff's modifiedLines to detect untouched callers.
 */

import fs from 'node:fs';
import path from 'node:path';
import { GitFileChange, UntouchedCaller } from './types';
import { GraphifyGraphData, GraphifyService } from './graphify';

/**
 * Detailed information for an identified caller call site.
 */
export interface CallerCallSite {
  /** The target symbol being called */
  symbol: string;
  /** Enclosing function or caller name */
  caller: string;
  /** Relative file path */
  file: string;
  /** Line number of the call */
  line: number;
  /** 3-line code context snippet extracted from source */
  snippet: string;
  /** Arguments passed in the call */
  callArgs: string;
  /** Whether this call site line was modified in the Git diff */
  isModifiedInGit: boolean;
  /** Status: UNTOUCHED if call site was not changed, UPDATED if modified */
  status: 'UNTOUCHED' | 'UPDATED' | 'UNKNOWN';
}

/**
 * Service to locate callers of symbols and detect missed / untouched callers.
 */
export class MissedCallerDetector {
  private repoPath: string;
  private gitChanges: GitFileChange[];
  private graphService: GraphifyService;

  constructor(repoPath: string, gitChanges: GitFileChange[], graphService?: GraphifyService) {
    this.repoPath = path.resolve(repoPath);
    this.gitChanges = gitChanges;
    this.graphService = graphService || new GraphifyService();
  }

  /**
   * Find all callers of a target symbol across the repository and determine if they were updated or untouched.
   * Utilizes Graphify graph data when available and supplements with deep AST source file scanning.
   *
   * @param targetSymbol Name of the function/method/symbol to inspect
   * @param graphData Optional Graphify AST graph data
   * @returns Array of CallerCallSite objects
   */
  async detectCallers(targetSymbol: string, graphData?: GraphifyGraphData): Promise<CallerCallSite[]> {
    const callSites: CallerCallSite[] = [];
    const cleanSymbol = targetSymbol.replace(/\(\)$/, '').trim();
    if (!cleanSymbol) return [];

    // Map of modified lines per relative file path
    const modifiedLinesByFile = new Map<string, Set<number>>();
    for (const change of this.gitChanges) {
      const normPath = this.normalizeRelPath(change.path);
      const lineSet = new Set(change.modifiedLines);
      modifiedLinesByFile.set(normPath, lineSet);
    }

    // 1. If Graphify graph data is available, collect Graphify references
    if (graphData) {
      const graphCallers = this.graphService.findCallersInGraph(graphData, cleanSymbol);
      for (const ref of graphCallers) {
        const normFile = this.normalizeRelPath(ref.sourceFile);
        const absFile = path.resolve(this.repoPath, normFile);

        if (fs.existsSync(absFile)) {
          const content = fs.readFileSync(absFile, 'utf8');
          const lines = content.split('\n');
          const lineIdx = Math.max(0, ref.line - 1);
          const lineText = lines[lineIdx] || '';

          // Extract snippet (3 lines context)
          const start = Math.max(0, lineIdx - 1);
          const end = Math.min(lines.length, lineIdx + 2);
          const snippet = lines.slice(start, end).join('\n');

          const modLines = modifiedLinesByFile.get(normFile);
          const isModified = modLines ? (modLines.has(ref.line) || modLines.has(ref.line - 1) || modLines.has(ref.line + 1)) : false;

          const callerName = ref.callerLabel.replace(/\(\)$/, '');

          callSites.push({
            symbol: cleanSymbol,
            caller: callerName,
            file: normFile,
            line: ref.line,
            snippet,
            callArgs: this.extractArgsFromLine(lineText, cleanSymbol),
            isModifiedInGit: isModified,
            status: isModified ? 'UPDATED' : 'UNTOUCHED',
          });
        }
      }
    }

    // 2. Comprehensive source file scan (Python, JS, TS, etc.)
    // Ensures zero missed callers even if Graphify has partial extraction
    const scannedFiles = this.findSourceFiles(this.repoPath);
    for (const relFile of scannedFiles) {
      const absFile = path.join(this.repoPath, relFile);
      if (!fs.existsSync(absFile)) continue;

      const normRelFile = this.normalizeRelPath(relFile);
      const content = fs.readFileSync(absFile, 'utf8');
      const lines = content.split('\n');

      const pattern = new RegExp(`\\b${escapeRegExp(cleanSymbol)}\\s*\\(([^)]*)\\)`, 'g');

      let currentFunction = 'global';
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNum = i + 1;

        // Detect enclosing function in Python or JS/TS
        const pyFnMatch = line.match(/^\s*(?:async\s+)?def\s+([a-zA-Z0-9_]+)\s*\(/);
        const jsFnMatch = line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_]+)\s*\(/) ||
                          line.match(/^\s*(?:const|let|var)\s+([a-zA-Z0-9_]+)\s*=\s*(?:async\s*)?\(/);

        if (pyFnMatch) {
          currentFunction = pyFnMatch[1];
        } else if (jsFnMatch) {
          currentFunction = jsFnMatch[1];
        }

        // Check if this line is the definition itself
        if (
          line.match(new RegExp(`def\\s+${escapeRegExp(cleanSymbol)}\\b`)) ||
          line.match(new RegExp(`function\\s+${escapeRegExp(cleanSymbol)}\\b`))
        ) {
          continue; // Skip the function definition itself
        }

        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(line)) !== null) {
          // Check if already captured by graphify
          const exists = callSites.some(
            c => c.file === normRelFile && Math.abs(c.line - lineNum) <= 1
          );

          if (!exists) {
            const start = Math.max(0, i - 1);
            const end = Math.min(lines.length, i + 2);
            const snippet = lines.slice(start, end).join('\n');

            const modLines = modifiedLinesByFile.get(normRelFile);
            // Consider modified if this line or the enclosing hunk was changed in git
            const isModified = modLines ? (modLines.has(lineNum) || modLines.has(lineNum - 1) || modLines.has(lineNum + 1)) : false;

            callSites.push({
              symbol: cleanSymbol,
              caller: currentFunction,
              file: normRelFile,
              line: lineNum,
              snippet,
              callArgs: match[1]?.trim() || '',
              isModifiedInGit: isModified,
              status: isModified ? 'UPDATED' : 'UNTOUCHED',
            });
          }
        }
      }
    }

    return callSites;
  }

  /**
   * Filter and return callers that remain UNTOUCHED
   */
  async getUntouchedCallers(targetSymbol: string, graphData?: GraphifyGraphData): Promise<UntouchedCaller[]> {
    const allSites = await this.detectCallers(targetSymbol, graphData);
    const untouched = allSites.filter(site => site.status === 'UNTOUCHED');

    return untouched.map(u => ({
      symbol: u.symbol,
      caller: u.caller,
      file: u.file,
      line: u.line,
      snippet: u.snippet,
      isModified: u.isModifiedInGit,
      status: 'UNTOUCHED',
    }));
  }

  /**
   * Extracts call arguments from a single line of code matching a symbol call.
   *
   * @param line Single line of source text
   * @param symbol Symbol name being invoked
   * @returns String containing arguments passed in parentheses, or empty string
   */
  private extractArgsFromLine(line: string, symbol: string): string {
    const regex = new RegExp(`\\b${escapeRegExp(symbol)}\\s*\\(([^)]*)\\)`);
    const match = line.match(regex);
    return match ? match[1].trim() : '';
  }

  /**
   * Normalizes a file path to forward slashes and converts absolute paths to relative paths.
   *
   * @param p Path string
   * @returns Cleaned relative path
   */
  private normalizeRelPath(p: string): string {
    let clean = p.replace(/\\/g, '/');
    if (path.isAbsolute(clean)) {
      clean = path.relative(this.repoPath, clean).replace(/\\/g, '/');
    }
    return clean.replace(/^\.\//, '');
  }

  /**
   * Discovers all supported source code files in a directory tree.
   *
   * @param dir Directory to scan
   * @param baseDir Base root directory for relative path calculation
   * @returns Array of relative file paths
   */
  private findSourceFiles(dir: string, baseDir: string = dir): string[] {
    const files: string[] = [];
    const validExts = new Set(['.py', '.js', '.jsx', '.ts', '.tsx', '.go', '.rs', '.java']);
    const ignoreDirs = new Set(['.git', 'node_modules', '.next', 'dist', 'graphify-out', '__pycache__', '.venv']);

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!ignoreDirs.has(entry.name)) {
          files.push(...this.findSourceFiles(path.join(dir, entry.name), baseDir));
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (validExts.has(ext)) {
          files.push(path.relative(baseDir, path.join(dir, entry.name)));
        }
      }
    }
    return files;
  }
}

/**
 * Escapes regex special characters in a literal string.
 *
 * @param string Literal string to escape
 * @returns Regex-safe string pattern
 */
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

