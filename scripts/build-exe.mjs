#!/usr/bin/env node
/**
 * Build a self-extracting Minions-ai executable for one target OS/arch.
 *
 * The app is bundled to a single CJS file, then packaged by @yao-pkg/pkg with
 * V8 bytecode. Native dependencies and the Copilot runtime are shipped as
 * embedded asset zips and extracted on first use (dlopen needs real files).
 *
 * Usage:
 *   node scripts/build-exe.mjs --target win-x64
 *   node scripts/build-exe.mjs --target mac-arm64
 *   node scripts/build-exe.mjs --target linux-x64
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { zipSync } from 'fflate';
import { build } from 'esbuild';
import { Data, NtExecutable, NtExecutableResource, Resource } from 'resedit';

const ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const targetArg = args.includes('--target') ? args[args.indexOf('--target') + 1] : 'win-x64';
const TARGETS = {
  'win-x64': { pkg: 'node24-win-x64', platform: 'win32', arch: 'x64', ext: '.exe' },
  'mac-arm64': { pkg: 'node24-macos-arm64', platform: 'darwin', arch: 'arm64', ext: '' },
  'mac-x64': { pkg: 'node24-macos-x64', platform: 'darwin', arch: 'x64', ext: '' },
  'linux-x64': { pkg: 'node24-linux-x64', platform: 'linux', arch: 'x64', ext: '' },
  'linux-arm64': { pkg: 'node24-linux-arm64', platform: 'linux', arch: 'arm64', ext: '' },
};
const target = TARGETS[targetArg];
if (!target) {
  console.error(`unknown --target ${targetArg}; choose ${Object.keys(TARGETS).join(', ')}`);
  process.exit(2);
}

const STAGE = join(ROOT, 'build', 'exe');
const ASSETS = join(STAGE, 'assets');
const RELEASE = join(ROOT, 'release');
const assetPlatform = `${target.platform === 'win32' ? 'win32' : target.platform}-${target.arch}`;

function run(command, commandArgs, label) {
  console.log(`\n> ${label ?? command}`);
  const needsShell = process.platform === 'win32' && (command === 'npm' || command === 'npx');
  const result = spawnSync(command, commandArgs, { cwd: ROOT, stdio: 'inherit', env: process.env, shell: needsShell });
  if (result.status !== 0) throw new Error(`${label ?? command} failed with exit ${result.status}`);
}

function collect(root, prefix = '', out = {}) {
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root)) {
    const abs = join(root, entry);
    if (statSync(abs).isDirectory()) collect(abs, `${prefix}${entry}/`, out);
    else out[`${prefix}${entry}`] = readFileSync(abs);
  }
  return out;
}

function writeGroup(group, files) {
  const dir = join(ASSETS);
  mkdirSync(dir, { recursive: true });
  const manifest = { version: '1.0.0', group, files: {} };
  for (const [name, bytes] of Object.entries(files)) {
    manifest.files[name] = createHash('sha256').update(bytes).digest('hex');
  }
  writeFileSync(join(dir, `assets-${group}.zip`), zipSync(files, { level: 0 }));
  writeFileSync(join(dir, `assets-${group}.json`), JSON.stringify(manifest, null, 2));
  console.log(`  ${group}: ${Object.keys(files).length} files, ${(Object.values(files).reduce((n, b) => n + b.length, 0) / 1024 / 1024).toFixed(1)} MB`);
}

function checkCopilot() {
  const pkg = join(ROOT, 'node_modules', `@github`, `copilot-sdk-${assetPlatform}`);
  if (!existsSync(pkg)) {
    throw new Error(`Copilot runtime for ${assetPlatform} is not installed. Build this target on its native OS or install @github/copilot-sdk-${assetPlatform}.`);
  }
  return pkg;
}

console.log(`Building Minions-ai for ${targetArg} (${target.pkg})`);
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(ASSETS, { recursive: true });
mkdirSync(RELEASE, { recursive: true });

if (!existsSync(join(ROOT, 'dist', 'web', 'index.html'))) {
  run('npm', ['--prefix', 'web', 'ci', '--no-audit', '--no-fund'], 'install cockpit');
  run('npm', ['--prefix', 'web', 'run', 'build'], 'build cockpit');
}

run('npx', ['--no-install', 'esbuild', 'src/cli.ts', '--bundle', '--platform=node', '--target=node22',
  '--format=cjs', '--outfile=build/exe/app.cjs', '--minify',
  '--external:koffi', '--external:@github/copilot-sdk-*'], 'bundle server + CLI');

writeGroup('web', collect(join(ROOT, 'dist', 'web')));
writeGroup('examples', collect(join(ROOT, 'examples')));
writeGroup('swagger', collect(join(ROOT, 'node_modules', '@fastify', 'swagger-ui', 'static')));

const sqlitePrebuild = join(ROOT, 'node_modules', 'better-sqlite3', 'prebuilds', `${assetPlatform}.node`);
if (!existsSync(sqlitePrebuild)) throw new Error(`SQLite prebuild missing: ${sqlitePrebuild}`);
writeGroup('native', { 'better_sqlite3.node': readFileSync(sqlitePrebuild) });

const copilotRoot = checkCopilot();
const copilotFiles = collect(copilotRoot);
for (const name of Object.keys(copilotFiles)) {
  if (name.startsWith('copilot-sdk/') || name.startsWith('docs/') || name.endsWith('.d.ts')) delete copilotFiles[name];
}
writeGroup('copilot', copilotFiles);

writeGroup('licenses', {
  'SECURITY.md': readFileSync(join(ROOT, 'SECURITY.md')),
  'THIRD-PARTY-NOTICES.txt': Buffer.from(
    'Minions-ai bundles Node.js (MIT), @github/copilot-sdk and its platform runtime (MIT), ' +
    'better-sqlite3 (MIT), Fastify (MIT), Ajv (MIT), and other MIT/ISC dependencies. ' +
    'See the package manifests for complete license texts.\n',
  ),
});

const pkgConfig = join(STAGE, 'pkg.config.json');
writeFileSync(pkgConfig, JSON.stringify({
  targets: [target.pkg],
  assets: ['build/exe/assets/**/*', 'assets/**/*'],
  bytecode: true,
  compress: 'GZip',
  nativeBuild: false,
}, null, 2));

const output = join(RELEASE, `minions-ai-${targetArg}${target.ext}`);
run('npx', ['--no-install', 'pkg', '-c', 'build/exe/pkg.config.json', '-o', `release/minions-ai-${targetArg}${target.ext}`, 'build/exe/app.cjs'], `package ${targetArg}`);

if (target.platform === 'win32') {
  // @yao-pkg/pkg has no icon option: replace the executable's icon resources.
  const exe = NtExecutable.from(readFileSync(output), { ignoreCert: true });
  const resources = NtExecutableResource.from(exe);
  const icon = Data.IconFile.from(readFileSync(join(ROOT, 'docs', 'media', 'minions-ai.ico')));
  Resource.IconGroupEntry.replaceIconsForResource(resources.entries, 1, 1033, icon.icons.map((item) => item.data));
  resources.outputResource(exe);
  writeFileSync(output, Buffer.from(exe.generate()));
  console.log(`embedded icon: docs/media/minions-ai.ico (${icon.icons.length} sizes)`);
}

const checksum = createHash('sha256').update(readFileSync(output)).digest('hex');
writeFileSync(`${output}.sha256`, `${checksum}  ${relative(ROOT, output).replaceAll('\\', '/')}\n`);
console.log(`\nBuilt ${output}`);
console.log(`SHA-256 ${checksum}`);
