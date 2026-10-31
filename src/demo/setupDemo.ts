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
  if (fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
  fs.mkdirSync(targetDir, { recursive: true });

  const run = async (args: string[]) => {
    return execFileAsync('git', args, { cwd: targetDir });
  };

  // 1. Initialize git repo
  await run(['init']);
  await run(['config', 'user.name', 'OffDiff Demo']);
  await run(['config', 'user.email', 'demo@offdiff.dev']);

  // 2. Write base code
  const filePath = path.join(targetDir, 'pricing.py');
  fs.writeFileSync(filePath, BASE_CODE, 'utf8');

  await run(['add', 'pricing.py']);
  await run(['commit', '-m', 'feat: initial pricing calculation with single sku argument']);

  const { stdout: baseRev } = await run(['rev-parse', 'HEAD']);

  // 3. Write HEAD code (incomplete or complete)
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
  setupDemoRepository().then(res => {
    console.log(`Demo repo created at ${res.repoPath} (Base: ${res.baseRev}, Head: ${res.headRev})`);
  });
}

