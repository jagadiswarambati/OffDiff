import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import { GraphifyStatus, DependencyRelationship } from './types';

const execAsync = promisify(exec);

export interface GraphifyNode {
  id: string;
  label: string;
  file_type?: string;
  source_file?: string;
  source_location?: string;
  _callable?: boolean;
  _origin?: string;
}

export interface GraphifyLink {
  source: string;
  target: string;
  relation: string;
  context?: string;
  source_file?: string;
  source_location?: string;
  confidence?: string;
  weight?: number;
}

export interface GraphifyGraphData {
  nodes: GraphifyNode[];
  links: GraphifyLink[];
}

export interface GraphifyCallReference {
  callerId: string;
  callerLabel: string;
  targetId: string;
  targetLabel: string;
  sourceFile: string;
  line: number;
  relation: string;
}

export class GraphifyService {
  private cmd: string;

  constructor(customCmd?: string) {
    this.cmd = customCmd || process.env.GRAPHIFY_CMD || 'python -m graphify';
  }

  /**
   * Check if Graphify CLI is available on the system
   */
  async checkAvailability(): Promise<{ available: boolean; version?: string; error?: string }> {
    try {
      const { stdout } = await execAsync(`${this.cmd} --help`, { timeout: 10000 });
      if (stdout.includes('Usage: graphify') || stdout.includes('graphify <command>')) {
        return { available: true, version: '0.9.99' };
      }
      return { available: false, error: 'Executable responded without expected Graphify help output' };
    } catch (err: unknown) {
      const error = err as Error;
      return {
        available: false,
        error: `Graphify not found or failed to execute (${this.cmd}): ${error.message}`,
      };
    }
  }

  /**
   * Generate or update the code knowledge graph for a repository
   */
  async generateGraph(repoPath: string): Promise<{
    status: GraphifyStatus;
    graphData?: GraphifyGraphData;
    outDir?: string;
  }> {
    const availability = await this.checkAvailability();
    if (!availability.available) {
      return {
        status: {
          available: false,
          executed: false,
          exitCode: 1,
          error: availability.error || 'Graphify is not installed or available in PATH',
          coverageWarning: 'Graphify code knowledge graph unavailable. Analysis falls back to AST / syntax scan with partial dependency coverage.',
        },
      };
    }

    const absRepoPath = path.resolve(repoPath);
    const graphifyOutDir = path.join(absRepoPath, 'graphify-out');
    const graphJsonPath = path.join(graphifyOutDir, 'graph.json');

    try {
      const { stdout, stderr } = await execAsync(`${this.cmd} update "${absRepoPath}" --no-cluster`, {
        cwd: absRepoPath,
        timeout: 45000,
        env: { ...process.env, GRAPHIFY_FORCE: '1' },
      });

      if (!fs.existsSync(graphJsonPath)) {
        return {
          status: {
            available: true,
            executed: false,
            exitCode: 1,
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            error: `Graphify executed but graph.json was not created at ${graphJsonPath}`,
            coverageWarning: 'graph.json missing after execution. Incomplete graph coverage.',
          },
        };
      }

      const rawJson = fs.readFileSync(graphJsonPath, 'utf8');
      const graphData: GraphifyGraphData = JSON.parse(rawJson);

      return {
        status: {
          available: true,
          version: availability.version,
          executed: true,
          exitCode: 0,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          graphJsonPath: path.relative(process.cwd(), graphJsonPath).replace(/\\/g, '/'),
          nodeCount: graphData.nodes?.length || 0,
          edgeCount: graphData.links?.length || 0,
        },
        graphData,
        outDir: graphifyOutDir,
      };
    } catch (err: unknown) {
      const error = err as Error & { code?: number; stdout?: string; stderr?: string };
      return {
        status: {
          available: true,
          executed: false,
          exitCode: error.code || 1,
          stdout: error.stdout?.trim(),
          stderr: error.stderr?.trim(),
          error: `Graphify execution error: ${error.message}`,
          coverageWarning: 'Graphify extraction interrupted or failed. Incomplete dependency coverage.',
        },
      };
    }
  }

  /**
   * Parse graph data to extract all dependency relationships
   */
  extractRelationships(
    graphData: GraphifyGraphData,
    modifiedLinesByFile: Map<string, Set<number>>
  ): DependencyRelationship[] {
    const relationships: DependencyRelationship[] = [];

    for (const link of graphData.links) {
      if (link.relation === 'calls' || link.relation === 'references' || link.relation === 'indirect_call') {
        const callerNode = graphData.nodes.find(n => n.id === link.source);
        const targetNode = graphData.nodes.find(n => n.id === link.target);

        let line = 1;
        if (link.source_location) {
          const m = link.source_location.match(/L(\d+)/i);
          if (m) line = parseInt(m[1], 10);
        }

        const callerLabel = (callerNode?.label || link.source).replace(/\(\)$/, '');
        const targetLabel = (targetNode?.label || link.target).replace(/\(\)$/, '');
        const relFile = (link.source_file || callerNode?.source_file || '').replace(/\\/g, '/');

        const modLines = modifiedLinesByFile.get(relFile);
        const isChanged = modLines ? (modLines.has(line) || modLines.has(line - 1) || modLines.has(line + 1)) : false;

        relationships.push({
          caller: callerLabel,
          callee: targetLabel,
          relation: link.relation,
          file: relFile,
          line,
          status: isChanged ? 'CHANGED' : 'UNCHANGED',
          source: 'graphify',
        });
      }
    }

    return relationships;
  }

  /**
   * Parse graph data to find all callers of a target function/symbol
   */
  findCallersInGraph(graphData: GraphifyGraphData, targetSymbol: string): GraphifyCallReference[] {
    const results: GraphifyCallReference[] = [];
    const normalizedTarget = targetSymbol.replace(/\(\)$/, '').toLowerCase();

    // Find node matching target symbol
    const targetNodes = graphData.nodes.filter(n => {
      const labelClean = n.label.replace(/\(\)$/, '').toLowerCase();
      return (
        labelClean === normalizedTarget ||
        n.id.toLowerCase().endsWith(`_${normalizedTarget}`) ||
        n.id.toLowerCase() === normalizedTarget
      );
    });

    const targetNodeIds = new Set(targetNodes.map(n => n.id));

    // Inspect links for callers
    for (const link of graphData.links) {
      if (link.relation === 'calls' || link.relation === 'references' || link.relation === 'indirect_call') {
        const matchesTarget =
          targetNodeIds.has(link.target) ||
          targetNodes.some(tn => link.target.endsWith(`_${normalizedTarget}`));

        if (matchesTarget) {
          const callerNode = graphData.nodes.find(n => n.id === link.source);
          const targetNode = graphData.nodes.find(n => n.id === link.target);

          let line = 1;
          if (link.source_location) {
            const lineMatch = link.source_location.match(/L(\d+)/i);
            if (lineMatch) {
              line = parseInt(lineMatch[1], 10);
            }
          }

          results.push({
            callerId: link.source,
            callerLabel: callerNode?.label || link.source,
            targetId: link.target,
            targetLabel: targetNode?.label || targetSymbol,
            sourceFile: link.source_file || callerNode?.source_file || '',
            line,
            relation: link.relation,
          });
        }
      }
    }

    return results;
  }
}
