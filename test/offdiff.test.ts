import { test, describe } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { setupDemoRepository } from '../src/demo/setupDemo';
import { OffDiffEngine } from '../src/core/engine';
import { inspectGitRepository } from '../src/core/git';
import { GraphifyService } from '../src/core/graphify';
import { AIService } from '../src/core/ai';

const demoDir = path.resolve(__dirname, '../demo-repo');

describe('OffDiff Verification Suite — 22 Acceptance Tests', async () => {
  const engine = new OffDiffEngine();

  test('1. Valid repository and valid base revision succeed', async () => {
    await setupDemoRepository(demoDir, 'incomplete');
    const gitInfo = await inspectGitRepository(demoDir, 'HEAD~1');

    assert.ok(gitInfo.repoPath);
    assert.ok(gitInfo.baseRevision);
    assert.strictEqual(gitInfo.modifiedFiles.includes('pricing.py'), true);
  });

  test('2. Invalid repository path produces a clear error', async () => {
    await assert.rejects(
      async () => {
        await inspectGitRepository('c:/non_existent_folder_xyz_123');
      },
      /Directory does not exist|Not a git repository/
    );
  });

  test('3. Invalid base revision produces a clear error', async () => {
    await setupDemoRepository(demoDir, 'incomplete');
    await assert.rejects(
      async () => {
        await inspectGitRepository(demoDir, 'non_existent_rev_xyz');
      },
      /Invalid base revision/
    );
  });

  test('4. Incomplete refactor detects untouched caller (receipt_total)', async () => {
    await setupDemoRepository(demoDir, 'incomplete');
    const result = await engine.runVerification({
      repoPath: demoDir,
      baseRevision: 'HEAD~1',
      summary: 'Updated all callers of get_price to pass the currency.',
    });

    assert.strictEqual(result.overallVerdict, 'FAILED');
    assert.strictEqual(result.stats.contradicted, 1);
    assert.strictEqual(result.stats.untouchedCallers, 1);

    const untouched = result.untouchedCallers[0];
    assert.strictEqual(untouched.symbol, 'get_price');
    assert.strictEqual(untouched.caller, 'receipt_total');
    assert.strictEqual(untouched.file, 'pricing.py');
    assert.strictEqual(untouched.line, 11);
  });

  test('5. Complete refactor verifies cleanly with no false missed callers', async () => {
    await setupDemoRepository(demoDir, 'complete');
    const result = await engine.runVerification({
      repoPath: demoDir,
      baseRevision: 'HEAD~1',
      summary: 'Updated all callers of get_price to pass the currency.',
    });

    assert.strictEqual(result.overallVerdict, 'PASSED');
    assert.strictEqual(result.stats.untouchedCallers, 0);
    assert.strictEqual(result.claims[0].status, 'VERIFIED');
  });

  test('6. Breaking function-signature changes are detected', async () => {
    await setupDemoRepository(demoDir, 'incomplete');
    const result = await engine.runVerification({
      repoPath: demoDir,
      baseRevision: 'HEAD~1',
      summary: 'No breaking changes.',
    });

    assert.ok(result.stats.atRisk > 0 || result.stats.contradicted > 0);
    assert.ok(result.findings.some(f => f.snippet.includes('def get_price')));
  });

  test('7. Git diff detects modified, added, and deleted files', async () => {
    await setupDemoRepository(demoDir, 'incomplete');
    const gitInfo = await inspectGitRepository(demoDir, 'HEAD~1');

    assert.ok(gitInfo.changes.some(c => c.path === 'pricing.py' && c.status === 'modified'));
    assert.ok(gitInfo.changes[0].diffHunks.length > 0);
  });

  test('8. Untracked files are captured and categorized in git changes', async () => {
    await setupDemoRepository(demoDir, 'incomplete');
    const untrackedFile = path.join(demoDir, 'untracked_test_script.py');
    fs.writeFileSync(untrackedFile, '# untracked test file', 'utf8');

    try {
      const gitInfo = await inspectGitRepository(demoDir, 'HEAD~1');
      assert.ok(gitInfo.untrackedFiles.includes('untracked_test_script.py'));
    } finally {
      if (fs.existsSync(untrackedFile)) fs.unlinkSync(untrackedFile);
    }
  });

  test('9. Graphify execution succeeds on valid repository', async () => {
    const graphService = new GraphifyService();
    const result = await graphService.generateGraph(demoDir);

    assert.strictEqual(result.status.available, true);
    assert.strictEqual(result.status.executed, true);
    assert.ok((result.status.nodeCount || 0) >= 3);
  });

  test('10. Graphify failure produces honest coverage warning without claiming success', async () => {
    await setupDemoRepository(demoDir, 'incomplete');
    const brokenGraphService = new OffDiffEngine('non_existent_graphify_cmd_xyz');
    const result = await brokenGraphService.runVerification({
      repoPath: demoDir,
      baseRevision: 'HEAD~1',
      summary: 'Updated all callers of get_price to pass the currency.',
    });

    assert.strictEqual(result.graphify.available, false);
    assert.strictEqual(result.graphify.executed, false);
    assert.ok(result.graphify.coverageWarning);
    // AST fallback detector still catches missed caller
    assert.strictEqual(result.stats.untouchedCallers, 1);
  });

  test('11. Dependency relationships are extracted and consumed by engine', async () => {
    await setupDemoRepository(demoDir, 'incomplete');
    const result = await engine.runVerification({
      repoPath: demoDir,
      baseRevision: 'HEAD~1',
      summary: 'Updated all callers of get_price to pass the currency.',
    });

    assert.ok(result.dependencyRelationships.length > 0);
    const invoiceRel = result.dependencyRelationships.find(r => r.caller === 'invoice_total');
    const receiptRel = result.dependencyRelationships.find(r => r.caller === 'receipt_total');

    assert.ok(invoiceRel, 'invoice_total relation should exist');
    assert.ok(receiptRel, 'receipt_total relation should exist');
    assert.strictEqual(invoiceRel.status, 'CHANGED');
    assert.strictEqual(receiptRel.status, 'UNCHANGED');
  });

  test('12. Evidence line numbers and snippets match actual source files', async () => {
    await setupDemoRepository(demoDir, 'incomplete');
    const result = await engine.runVerification({
      repoPath: demoDir,
      baseRevision: 'HEAD~1',
      summary: 'Updated all callers of get_price to pass the currency.',
    });

    for (const ev of result.findings) {
      const absFile = path.resolve(demoDir, ev.filePath);
      assert.strictEqual(fs.existsSync(absFile), true);
      const content = fs.readFileSync(absFile, 'utf8');
      const lines = content.split('\n');
      assert.ok(ev.lineNumber > 0 && ev.lineNumber <= lines.length);
      const firstLine = ev.snippet.trim().split('\n')[0].trim();
      assert.strictEqual(content.includes(firstLine), true);
    }
  });

  test('13. Missing AI credentials do not break deterministic verification', async () => {
    const emptyAi = new AIService('   ');
    assert.strictEqual(emptyAi.isConfigured(), false);
    const res = await emptyAi.investigateClaim('any claim', [], demoDir);
    assert.strictEqual(res.verdict, 'UNVERIFIABLE');
  });

  test('14. AI API failures and errors do not crash application', async () => {
    const invalidAi = new AIService('invalid_key_123');
    const res = await invalidAi.investigateClaim('any claim', [], demoDir);
    assert.ok(['UNVERIFIABLE', 'CONTRADICTED', 'AT RISK'].includes(res.verdict));
    assert.strictEqual(typeof res.explanation, 'string');
  });

  test('15. CLI Gate returns non-zero exit code (1) on CONTRADICTED', async () => {
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
      exitCode = (err as { status?: number }).status || 1;
    }

    assert.strictEqual(exitCode, 1);
  });

  test('16. CLI Gate returns zero exit code (0) on complete refactor', async () => {
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
      exitCode = (err as { status?: number }).status || 1;
    }

    assert.strictEqual(exitCode, 0);
  });

  test('17. CLI Gate outputs valid JSON matching schema with --json', async () => {
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
      stdout = (err as { stdout?: string }).stdout || '';
    }

    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.overallVerdict, 'FAILED');
    assert.ok(parsed.dependencyRelationships.length > 0);
    assert.ok(parsed.suggestedAction.length > 0);
  });

  test('18. Strict mode exits with non-zero on warnings or partial analysis', async () => {
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
        'No breaking changes.',
        '--strict',
      ], { stdio: 'pipe' });
    } catch (err: unknown) {
      exitCode = (err as { status?: number }).status || 1;
    }

    assert.ok(exitCode > 0);
  });

  test('19. Dashboard suggested action is populated correctly', async () => {
    await setupDemoRepository(demoDir, 'incomplete');
    const result = await engine.runVerification({
      repoPath: demoDir,
      baseRevision: 'HEAD~1',
      summary: 'Updated all callers of get_price to pass the currency.',
    });

    assert.ok(result.suggestedAction.includes('receipt_total'));
  });

  test('20. Changed functions are detected in Git diff with signatures', async () => {
    await setupDemoRepository(demoDir, 'incomplete');
    const result = await engine.runVerification({
      repoPath: demoDir,
      baseRevision: 'HEAD~1',
      summary: 'Updated all callers of get_price to pass the currency.',
    });

    assert.ok(result.changedFunctions.length > 0);
    const getPriceFn = result.changedFunctions.find(f => f.name === 'get_price');
    assert.ok(getPriceFn);
    assert.ok(getPriceFn.newSignature?.includes('currency'));
  });

  test('21. Demo scenario switching is repeatable and deterministic', async () => {
    await setupDemoRepository(demoDir, 'incomplete');
    const r1 = await engine.runVerification({ repoPath: demoDir, baseRevision: 'HEAD~1', summary: 'Updated all callers of get_price to pass the currency.' });
    assert.strictEqual(r1.overallVerdict, 'FAILED');

    await setupDemoRepository(demoDir, 'complete');
    const r2 = await engine.runVerification({ repoPath: demoDir, baseRevision: 'HEAD~1', summary: 'Updated all callers of get_price to pass the currency.' });
    assert.strictEqual(r2.overallVerdict, 'PASSED');

    await setupDemoRepository(demoDir, 'incomplete');
    const r3 = await engine.runVerification({ repoPath: demoDir, baseRevision: 'HEAD~1', summary: 'Updated all callers of get_price to pass the currency.' });
    assert.strictEqual(r3.overallVerdict, 'FAILED');
  });

  test('22. Repeated verification without modifying repository state preserves output', async () => {
    await setupDemoRepository(demoDir, 'incomplete');
    const r1 = await engine.runVerification({ repoPath: demoDir, baseRevision: 'HEAD~1', summary: 'Updated all callers of get_price to pass the currency.' });
    const r2 = await engine.runVerification({ repoPath: demoDir, baseRevision: 'HEAD~1', summary: 'Updated all callers of get_price to pass the currency.' });

    assert.strictEqual(r1.overallVerdict, r2.overallVerdict);
    assert.strictEqual(r1.stats.untouchedCallers, r2.stats.untouchedCallers);
    assert.strictEqual(r1.untouchedCallers[0].caller, r2.untouchedCallers[0].caller);
  });
});
