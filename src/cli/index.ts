/**
 * @file index.ts
 * @description CLI command specification and console report formatter for OffDiff.
 * Implements `offdiff check` with options for `--base`, `--summary`, `--repo`, `--json`,
 * `--strict`, and `--ai`. Manages CI/CD exit codes (0=PASS, 1=FAIL/CONTRADICTED, 2=STRICT WARNING).
 */

import { Command } from 'commander';
import pc from 'picocolors';
import path from 'node:path';
import { OffDiffEngine } from '../core/engine';
import { VerificationResult } from '../core/types';
import { isRemoteGitUrl } from '../core/git';

/**
 * Constructs and configures the Commander CLI program.
 */
export function createCli(): Command {
  const program = new Command();

  program
    .name('offdiff')
    .description('OffDiff — AI Coding Agent Completion Claim Verifier')
    .version('0.1.0');

  program
    .command('check')
    .description('Verify coding agent completion claims against git diff and codebase')
    .option('-b, --base <rev>', 'Base Git revision to compare against', 'HEAD~1')
    .option('-s, --summary <text>', 'Completion claim summary from the AI agent')
    .option('-r, --repo <path>', 'Path to local Git repository', '.')
    .option('--json', 'Output results as JSON', false)
    .option('--strict', 'Fail if graph coverage is partial or at-risk findings exist', false)
    .option('--ai', 'Enable Google GenAI investigation for ambiguous claims', false)
    .action(async (options) => {
      try {
        if (!options.summary) {
          console.error(pc.red('Error: --summary <text> is required.'));
          process.exitCode = 1;
          return;
        }

        const repoPath = isRemoteGitUrl(options.repo)
          ? options.repo
          : path.resolve(options.repo);
        const engine = new OffDiffEngine();

        if (!options.json) {
          console.log(pc.bold(pc.cyan('\n🔍 OffDiff Claim Verification Gate')));
          console.log(pc.dim(`   Repository: ${repoPath}`));
          console.log(pc.dim(`   Base Rev:   ${options.base}`));
          console.log(pc.dim(`   Summary:    "${options.summary}"\n`));
        }

        const result = await engine.runVerification({
          repoPath,
          baseRevision: options.base,
          summary: options.summary,
          strict: options.strict,
          useAi: options.ai,
        });

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          printCliReport(result);
        }

        // Determine exit code
        if (result.overallVerdict === 'FAILED') {
          process.exitCode = 1;
          return;
        }
        if (options.strict && result.overallVerdict === 'WARNING') {
          console.error(pc.red('\n[Strict Mode] Analysis completed with warnings or incomplete coverage. Exiting with error.'));
          process.exitCode = 2;
          return;
        }

        process.exitCode = 0;
      } catch (err: unknown) {
        const error = err as Error;
        if (options.json) {
          console.error(JSON.stringify({ error: error.message }, null, 2));
        } else {
          console.error(pc.red(`\n❌ Error during verification: ${error.message}`));
        }
        process.exitCode = 1;
      }
    });

  return program;
}

function printCliReport(result: VerificationResult) {
  // Graphify status banner
  if (result.graphify.executed) {
    console.log(pc.green(`✔ Graphify AST Graph: ${result.graphify.nodeCount} nodes, ${result.graphify.edgeCount} edges (${result.graphify.graphJsonPath || 'graph.json'})`));
  } else {
    console.log(pc.yellow(`⚠ Graphify Notice: ${result.graphify.coverageWarning || result.graphify.error}`));
  }

  // Changed functions section
  if (result.changedFunctions.length > 0) {
    console.log(pc.bold('\n--- Changed Functions in Git Diff ---'));
    for (const fn of result.changedFunctions) {
      console.log(`  • ${pc.cyan(fn.name)} at ${fn.file}:${fn.line} ${fn.newSignature ? pc.dim(`→ ${fn.newSignature}`) : ''}`);
    }
  }

  // Dependency graph caller relationships
  if (result.dependencyRelationships.length > 0) {
    console.log(pc.bold('\n--- Dependency Graph Call Sites ---'));
    for (const dep of result.dependencyRelationships) {
      const statusPill = dep.status === 'CHANGED' ? pc.green(' [CHANGED] ') : pc.red(' [UNCHANGED] ');
      console.log(`  • ${statusPill} ${pc.bold(dep.caller)}() calls ${pc.cyan(dep.callee)} at ${dep.file}:${dep.line}`);
    }
  }

  // Summary stats
  console.log(pc.bold('\n--- Verification Statistics ---'));
  console.log(`Claims Checked:     ${result.stats.totalClaims}`);
  console.log(`Verified Claims:    ${pc.green(result.stats.verified.toString())}`);
  console.log(`Contradicted:       ${result.stats.contradicted > 0 ? pc.red(result.stats.contradicted.toString()) : '0'}`);
  console.log(`Untouched Callers:  ${result.stats.untouchedCallers > 0 ? pc.bold(pc.red(result.stats.untouchedCallers.toString())) : '0'}`);
  console.log(`At Risk / Warn:     ${result.stats.atRisk > 0 ? pc.yellow(result.stats.atRisk.toString()) : '0'}`);

  // Findings
  console.log(pc.bold('\n--- Claims & Verdicts ---'));
  for (const claim of result.claims) {
    const badge = formatVerdictBadge(claim.status);
    console.log(`\n${badge} "${pc.bold(claim.rawText)}"`);
    console.log(`   ${pc.dim(claim.explanation)}`);

    for (const ev of claim.evidence) {
      console.log(`   ${pc.cyan('↳ Location:')} ${pc.underline(`${ev.filePath}:${ev.lineNumber}`)} [${ev.source.toUpperCase()}]`);
      if (ev.callerName) {
        console.log(`     ${pc.dim('Caller:')} ${ev.callerName}`);
      }
      console.log(`     ${pc.dim('Snippet:')}`);
      const snippetLines = ev.snippet.split('\n');
      for (const line of snippetLines) {
        console.log(`       ${pc.bgBlack(pc.white(` ${line} `))}`);
      }
    }
  }

  // Untouched Callers section
  if (result.untouchedCallers.length > 0) {
    console.log(pc.bold(pc.red('\n🚨 Untouched Code Detected (Missed Callers):')));
    for (const u of result.untouchedCallers) {
      console.log(pc.red(`  • Function '${u.caller}' calls '${u.symbol}' at ${u.file}:${u.line}`));
      console.log(pc.dim(`    Evidence: ${u.snippet.replace(/\n/g, ' ')}`));
    }
  }

  if (result.suggestedAction) {
    console.log(pc.bold('\n💡 Suggested Action:'));
    console.log(`   ${pc.yellow(result.suggestedAction)}`);
  }

  // Overall Gate Verdict
  console.log(pc.bold('\n========================================'));
  if (result.overallVerdict === 'PASSED') {
    console.log(pc.bold(pc.bgGreen(pc.black(' GATE STATUS: PASSED (ALL CLAIMS VERIFIED) '))));
  } else if (result.overallVerdict === 'FAILED') {
    console.log(pc.bold(pc.bgRed(pc.white(' GATE STATUS: FAILED (CLAIMS CONTRADICTED) '))));
  } else {
    console.log(pc.bold(pc.bgYellow(pc.black(' GATE STATUS: WARNING (AT RISK / INCOMPLETE) '))));
  }
  console.log(pc.bold('========================================\n'));
}

function formatVerdictBadge(verdict: string): string {
  switch (verdict) {
    case 'VERIFIED':
    case 'UPDATED':
      return pc.bgGreen(pc.black(` ${verdict} `));
    case 'CONTRADICTED':
    case 'UNTOUCHED':
      return pc.bgRed(pc.white(` ${verdict} `));
    case 'AT RISK':
      return pc.bgYellow(pc.black(` ${verdict} `));
    default:
      return pc.gray(` ${verdict} `);
  }
}

