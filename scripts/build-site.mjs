#!/usr/bin/env node
/**
 * Build the GitHub Pages site from the README, end-user docs and media.
 * Generated pages and public media are disposable build inputs.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const SITE = join(ROOT, 'site');
const PUBLIC = join(SITE, 'public');
const GENERATED = [
  'README.md',
  'TEAMS-GUIDE.md',
  'A2A.md',
  'UAT.md',
  'EXECUTABLE.md',
  'CLI.md',
  'API.md',
  'SECURITY.md',
];

const GITHUB = 'https://github.com/siddharth-mishra-28/minions-ai';

function rewrite(markdown, source) {
  let out = markdown
    .replaceAll('docs/media/', '/media/')
    .replaceAll('docs/TEAMS-GUIDE.md', '/TEAMS-GUIDE')
    .replaceAll('docs/A2A.md', '/A2A')
    .replaceAll('docs/UAT.md', '/UAT')
    .replaceAll('docs/EXECUTABLE.md', '/EXECUTABLE')
    .replaceAll('docs/CLI.md', '/CLI')
    .replaceAll('docs/API.md', '/API')
    .replaceAll('](SECURITY.md)', '](/SECURITY)')
    .replaceAll('](../SECURITY.md)', '](/SECURITY)')
    .replaceAll('](../README.md)', '](/README)')
    .replaceAll('](README.md)', '](/README)')
    .replaceAll('](../README.md#', '](/README#')
    .replaceAll('](A2A.md)', '](/A2A)')
    .replaceAll('](UAT.md)', '](/UAT)')
    .replaceAll('](../UAT.md)', '](/UAT)')
    .replaceAll('](../docs/TEAMS-GUIDE.md)', '](/TEAMS-GUIDE)')
    .replaceAll('](../docs/A2A.md)', '](/A2A)')
    .replaceAll('](LICENSE)', `](${GITHUB}/blob/main/LICENSE)`)
    .replaceAll('](../LICENSE)', `](${GITHUB}/blob/main/LICENSE)`)
    .replaceAll('](../ci/', `](${GITHUB}/tree/main/ci/`)
    .replaceAll('../evidences', `${GITHUB}/tree/main/evidences`)
    .replaceAll('](../.gitlab-ci.yml)', `](${GITHUB})`);

  // Relative media inside docs/ is served from the site's public media folder.
  out = out.replaceAll('](media/', '](/media/');
  out = out.replaceAll('](media/', '](/media/');
  out = out.replaceAll('"media/', '"/media/');
  out = out.replaceAll('src="media/', 'src="/media/');
  out = out.replaceAll('src="docs/media/', 'src="/media/');

  // Keep absolute public media paths stable, including hero/logo references.
  out = out.replaceAll('](/media/', '](/media/');

  if (!out.startsWith('---\n')) out = `---\nlayout: doc\n---\n\n${out}`;
  return out;
}

function writePage(name, sourcePath) {
  if (!existsSync(sourcePath)) {
    console.warn(`skip ${name}: ${sourcePath} not found`);
    return;
  }
  writeFileSync(join(SITE, name), rewrite(readFileSync(sourcePath, 'utf8'), sourcePath));
  console.log(`generated site/${name}`);
}

mkdirSync(PUBLIC, { recursive: true });
for (const page of GENERATED) rmSync(join(SITE, page), { force: true });
rmSync(join(PUBLIC, 'media'), { recursive: true, force: true });
cpSync(join(ROOT, 'docs', 'media'), join(PUBLIC, 'media'), { recursive: true });
console.log('copied docs/media -> site/public/media');

writePage('README.md', join(ROOT, 'README.md'));
writePage('TEAMS-GUIDE.md', join(ROOT, 'docs', 'TEAMS-GUIDE.md'));
writePage('A2A.md', join(ROOT, 'docs', 'A2A.md'));
writePage('UAT.md', join(ROOT, 'docs', 'UAT.md'));
writePage('EXECUTABLE.md', join(ROOT, 'docs', 'EXECUTABLE.md'));
writePage('CLI.md', join(ROOT, 'docs', 'CLI.md'));
writePage('API.md', join(ROOT, 'docs', 'API.md'));
writePage('SECURITY.md', join(ROOT, 'SECURITY.md'));

const vitepress = join(ROOT, 'node_modules', 'vitepress', 'bin', 'vitepress.js');
if (!existsSync(vitepress)) {
  console.error('vitepress is not installed; run npm install first.');
  process.exit(1);
}
const result = spawnSync(process.execPath, [vitepress, 'build', SITE], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, NODE_OPTIONS: process.env.NODE_OPTIONS ?? '' },
});
if (result.status !== 0) process.exit(result.status ?? 1);
console.log('site built: site/.vitepress/dist');
