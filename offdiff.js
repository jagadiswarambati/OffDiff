#!/usr/bin/env node
/**
 * @file offdiff.js
 * @description Project root executable CLI entrypoint for OffDiff.
 * Forwards command-line arguments to `bin/offdiff.js`, invoking the
 * TypeScript CLI gate runner via `tsx` across Windows, Linux, and macOS.
 *
 * Example usage:
 *   node offdiff.js check --summary "Updated all callers of get_price"
 *   node offdiff.js check --repo https://github.com/owner/repo --base HEAD~1
 */

require('./bin/offdiff.js');

