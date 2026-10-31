/**
 * @file route.ts
 * @description API endpoint: /api/demo
 * GET: Lists mandatory demo scenarios (Incomplete Refactor, Complete Refactor, Breaking Changes).
 * POST: Dynamically switches the local `demo-repo` state between incomplete and complete modes.
 */

import { NextRequest, NextResponse } from 'next/server';
import path from 'node:path';
import { setupDemoRepository } from '@/demo/setupDemo';

export async function GET() {
  const demoPath = path.resolve(process.cwd(), 'demo-repo');
  return NextResponse.json({
    demoPath,
    scenarios: [
      {
        id: 'incomplete',
        name: 'Incomplete Refactor (Missed Caller)',
        summary: 'Updated all callers of get_price to pass the currency.',
        baseRevision: 'HEAD~1',
        description: 'receipt_total was left untouched while invoice_total and export_total were updated.',
        expectedVerdict: 'CONTRADICTED (GATE FAILED)',
      },
      {
        id: 'complete',
        name: 'Complete Refactor (All Callers Updated)',
        summary: 'Updated all callers of get_price to pass the currency.',
        baseRevision: 'main~1',
        branch: 'complete-refactor',
        description: 'All 3 callers (invoice_total, export_total, receipt_total) are updated to pass "INR".',
        expectedVerdict: 'VERIFIED (GATE PASSED)',
      },
      {
        id: 'breaking-changes',
        name: 'Breaking Change Claim Check',
        summary: 'No breaking changes.',
        baseRevision: 'HEAD~1',
        description: 'Tests detection of signature modifications without default parameter values.',
        expectedVerdict: 'AT RISK (GATE WARNING)',
      },
    ],
  });
}

export async function POST(req: NextRequest) {
  try {
    const { scenario } = await req.json();
    const demoDir = path.resolve(process.cwd(), 'demo-repo');

    if (scenario === 'complete') {
      await setupDemoRepository(demoDir, 'complete');
      return NextResponse.json({
        success: true,
        message: 'Demo repo set to complete refactor mode',
        repoPath: demoDir,
        baseRevision: 'HEAD~1',
      });
    } else {
      await setupDemoRepository(demoDir, 'incomplete');
      return NextResponse.json({
        success: true,
        message: 'Demo repo set to incomplete refactor mode (missed caller)',
        repoPath: demoDir,
        baseRevision: 'HEAD~1',
      });
    }
  } catch (err: unknown) {
    const error = err as Error;
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

