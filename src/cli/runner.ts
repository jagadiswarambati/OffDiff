/**
 * @file runner.ts
 * @description Command-line execution runner for tsx/Node invocation of OffDiff CLI.
 * Boots the Commander CLI instance created by `createCli()` and parses arguments from `process.argv`.
 * Manages asynchronous command action dispatch and sets appropriate exit codes for CI/CD gates.
 */

import { createCli } from './index';

// Initialize and parse CLI arguments passed to the Node process
createCli().parse(process.argv);

