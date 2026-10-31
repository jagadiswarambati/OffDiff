import { test, describe } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setupDemoRepository } from '../src/demo/setupDemo';
import { OffDiffEngine } from '../src/core/engine';
import { inspectGitRepository } from '../src/core/git';
import { GraphifyService } from '../src/core/graphify';

const demoDir = path.resolve(__dirname, '../demo-repo');

describe('OffDiff Verification Engine', async () => {
  const engine = new OffDiffEngine();

  test('1. Git repository inspection detects file changes and hunks', async () => {
    await setupDemoRepository(demoDir, 'incomplete');
    const gitInfo = await inspectGitRepository(demoDir, 'HEAD~1');

    assert.strictEqual(gitInfo.modifiedFiles.includes('pricing.py'), true);
    assert.strictEqual(gitInfo.changes.length > 0, true);
    const pricingChange = gitInfo.changes.find(c => c.path === 'pricing.py');
    assert.ok(pricingChange, 'pricing.py should be in changes');
    assert.strictEqual(pricingChange.status, 'modified');
    assert.ok(pricingChange.modifiedLines.length > 0, 'Should track modified line numbers');
  });

  test('2. Graphify AST extraction extracts nodes and callers', async () => {
    const graphService = new GraphifyService();
    const result = await graphService.generateGraph(demoDir);

    assert.strictEqual(result.status.available, true);
    assert.strictEqual(result.status.executed, true);
    assert.ok((result.status.nodeCount || 0) >= 3, 'Should have extracted nodes');
    assert.ok((result.status.edgeCount || 0) >= 3, 'Should have extracted caller edges');
  });

  test('3. Mandatory Demo: Incomplete Refactor detects untouched caller (CONTRADICTED)', async () => {
    await setupDemoRepository(demoDir, 'incomplete');

    const result = await engine.runVerification({
      repoPath: demoDir,
      baseRevision: 'HEAD~1',
      summary: 'Updated all callers of get_price to pass the currency.',
      strict: false,
      useAi: false,
    });

    assert.strictEqual(result.overallVerdict, 'FAILED');
    assert.strictEqual(result.stats.contradicted, 1);
    assert.strictEqual(result.stats.untouchedCallers, 1);

    const untouched = result.untouchedCallers[0];
    assert.strictEqual(untouched.symbol, 'get_price');
    assert.strictEqual(untouched.caller, 'receipt_total');
    assert.strictEqual(untouched.file, 'pricing.py');
    assert.strictEqual(untouched.line, 11);
    assert.ok(untouched.snippet.includes('receipt_total'));

    const claim = result.claims[0];
    assert.strictEqual(claim.status, 'CONTRADICTED');
    assert.strictEqual(claim.evidence.length > 0, true);
    assert.strictEqual(claim.evidence[0].lineNumber, 11);
    assert.strictEqual(claim.evidence[0].validated, true);
  });

  test('4. Mandatory Demo: Complete Refactor does NOT report false missed callers (VERIFIED)', async () => {
    await setupDemoRepository(demoDir, 'complete');

    const result = await engine.runVerification({
      repoPath: demoDir,
      baseRevision: 'HEAD~1',
      summary: 'Updated all callers of get_price to pass the currency.',
      strict: false,
      useAi: false,
    });

    assert.strictEqual(result.overallVerdict, 'PASSED');
    assert.strictEqual(result.stats.contradicted, 0);
    assert.strictEqual(result.stats.untouchedCallers, 0);
    assert.strictEqual(result.stats.verified, 1);

    const claim = result.claims[0];
    assert.strictEqual(claim.status, 'VERIFIED');
  });

  test('5. CLI Gate returns non-zero exit code on CONTRADICTED', async () => {
    await setupDemoRepository(demoDir, 'incomplete');
    const cliScript = path.resolve(__dirname, '../offdiff.js');

    let exitCode = 0;
    try {
      execFileSync(process.execPath, [
        cliScript,
        'check',
        '--repo',
        demoDir,
        '--base',
        'HEAD~1',
        '--summary',
        'Updated all callers of get_price to pass the currency.',
      ], { stdio: 'pipe' });
    } catch (err: unknown) {
      const e = err as { status?: number };
      exitCode = e.status || 1;
    }

    assert.strictEqual(exitCode, 1, 'Incomplete refactor must return exit code 1');
  });

  test('6. CLI Gate returns zero exit code on complete refactor', async () => {
    await setupDemoRepository(demoDir, 'complete');
    const cliScript = path.resolve(__dirname, '../offdiff.js');

    let exitCode = 0;
    try {
      execFileSync(process.execPath, [
        cliScript,
        'check',
        '--repo',
        demoDir,
        '--base',
        'HEAD~1',
        '--summary',
        'Updated all callers of get_price to pass the currency.',
      ], { stdio: 'pipe' });
    } catch (err: unknown) {
      const e = err as { status?: number };
      exitCode = e.status || 1;
    }

    assert.strictEqual(exitCode, 0, 'Complete refactor must return exit code 0');
  });

  test('7. CLI Gate supports JSON output flag', async () => {
    await setupDemoRepository(demoDir, 'incomplete');
    const cliScript = path.resolve(__dirname, '../offdiff.js');

    let stdout = '';
    try {
      stdout = execFileSync(process.execPath, [
        cliScript,
        'check',
        '--repo',
        demoDir,
        '--base',
        'HEAD~1',
        '--summary',
        'Updated all callers of get_price to pass the currency.',
        '--json',
      ], { stdio: 'pipe', encoding: 'utf8' });
    } catch (err: unknown) {
      const e = err as { stdout?: string };
      stdout = e.stdout || '';
    }

    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.overallVerdict, 'FAILED');
    assert.strictEqual(parsed.untouchedCallers.length, 1);
    assert.strictEqual(parsed.untouchedCallers[0].caller, 'receipt_total');
  });
});

