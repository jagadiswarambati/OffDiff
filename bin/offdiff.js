#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const runnerPath = path.resolve(__dirname, '../src/cli/runner.ts');
const tsxPath = path.resolve(__dirname, '../node_modules/tsx/dist/cli.mjs');

const result = spawnSync(process.execPath, [tsxPath, runnerPath, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});

process.exitCode = result.status ?? 0;
