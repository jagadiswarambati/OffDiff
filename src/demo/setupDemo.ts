import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';

const execFileAsync = promisify(execFile);

export const BASE_CODE = `def get_price(sku):
    return 100

def invoice_total(sku):
    return get_price(sku)

def export_total(sku):
    return get_price(sku)

def receipt_total(sku):
    return get_price(sku)
`;

export const INCOMPLETE_HEAD_CODE = `def get_price(sku, currency):
    return 100

def invoice_total(sku):
    return get_price(sku, "INR")

def export_total(sku):
    return get_price(sku, "INR")

def receipt_total(sku):
    return get_price(sku)
`;

export const COMPLETE_HEAD_CODE = `def get_price(sku, currency):
    return 100

def invoice_total(sku):
    return get_price(sku, "INR")

def export_total(sku):
    return get_price(sku, "INR")

def receipt_total(sku):
    return get_price(sku, "INR")
`;

export async function setupDemoRepository(
  targetDir: string = path.resolve(process.cwd(), 'demo-repo'),
  mode: 'incomplete' | 'complete' = 'incomplete'
): Promise<{ repoPath: string; baseRev: string; headRev: string }> {
  const filePath = path.join(targetDir, 'pricing.py');

  const run = async (args: string[]) => {
    return execFileAsync('git', args, { cwd: targetDir });
  };

  const isGitRepo = fs.existsSync(path.join(targetDir, '.git'));
  if (!isGitRepo) {
    fs.mkdirSync(targetDir, { recursive: true });
    await run(['init', '-b', 'main']);
    await run(['config', 'user.name', 'OffDiff Demo']);
    await run(['config', 'user.email', 'demo@offdiff.dev']);
  }

  // Ensure clean working tree on main branch
  try {
    await run(['checkout', '-f', 'main']);
  } catch {
    // Ignore if already on main
  }

  // Check if we have commits in the repo
  let hasCommits = false;
  try {
    await run(['rev-parse', 'HEAD']);
    hasCommits = true;
  } catch {
    hasCommits = false;
  }

  if (hasCommits) {
    // Reset to root commit so history is always exactly 2 commits: BASE -> HEAD
    try {
      const { stdout: rootList } = await run(['rev-list', '--max-parents=0', 'HEAD']);
      const rootCommit = rootList.split('\n')[0].trim();
      if (rootCommit) {
        await run(['reset', '--hard', rootCommit]);
        await run(['clean', '-fd']);
      }
    } catch {
      // If reset fails, continue
    }
  }

  // 1. Commit BASE version
  fs.writeFileSync(filePath, BASE_CODE, 'utf8');
  await run(['add', 'pricing.py']);

  if (!hasCommits) {
    await run(['commit', '-m', 'feat: initial pricing calculation with single sku argument']);
  } else {
    await run(['commit', '--amend', '-m', 'feat: initial pricing calculation with single sku argument']);
  }

  const { stdout: baseRev } = await run(['rev-parse', 'HEAD']);

  // 2. Commit HEAD version (incomplete or complete)
  const headCode = mode === 'incomplete' ? INCOMPLETE_HEAD_CODE : COMPLETE_HEAD_CODE;
  fs.writeFileSync(filePath, headCode, 'utf8');
  await run(['add', 'pricing.py']);

  const commitMsg =
    mode === 'incomplete'
      ? 'refactor: updated get_price signature and some callers (receipt_total missed)'
      : 'refactor: updated get_price signature and all callers to pass currency';

  await run(['commit', '-m', commitMsg]);

  const { stdout: headRev } = await run(['rev-parse', 'HEAD']);

  return {
    repoPath: targetDir,
    baseRev: baseRev.trim().slice(0, 8),
    headRev: headRev.trim().slice(0, 8),
  };
}

if (process.argv[1]?.includes('setupDemo')) {
  const mode = process.argv[2] === 'complete' ? 'complete' : 'incomplete';
  setupDemoRepository(undefined, mode).then(res => {
    console.log(`Demo repo created in '${mode}' mode at ${res.repoPath} (Base: ${res.baseRev}, Head: ${res.headRev})`);
  });
}
