#!/usr/bin/env node
/**
 * npm postinstall bridge.
 *
 * The actual first-run logic lives in dist/cli.js (`init --postinstall`) so it can
 * be tested and reused. This file only decides whether it is safe to ask:
 *   - never in CI or when MINIONS_SKIP_INIT=1
 *   - never without an interactive TTY
 *   - never before the CLI has been built (source checkout `npm install`)
 *   - never inside the package's own repository
 * It always exits 0: setup problems must not break installation.
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, 'dist', 'cli.js');

if (!existsSync(cli)) process.exit(0);

if (process.env.CI || process.env.MINIONS_SKIP_INIT === '1' || !process.stdin.isTTY || !process.stdout.isTTY) {
  console.log('\nMinions-ai installed. Run "minions-ai init" to configure a provider.\n');
  process.exit(0);
}

const result = spawnSync(process.execPath, [cli, 'init', '--postinstall'], {
  stdio: 'inherit',
  env: process.env,
  cwd: process.env.INIT_CWD || process.cwd(),
});
process.exit(result.status ?? 0);
