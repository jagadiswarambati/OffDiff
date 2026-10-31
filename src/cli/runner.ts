/**
 * @file runner.ts
 * @description Command-line execution runner for tsx/Node invocation of OffDiff CLI.
 */

import { createCli } from './index';

createCli().parse(process.argv);

