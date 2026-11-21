import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';

type Group = 'web' | 'examples' | 'swagger' | 'native' | 'copilot';

let base: string;
let embedded: string;
let cache: string;

function stage(group: Group, files: Record<string, Uint8Array>, badHash = false): void {
  const manifest = { version: '1.0.0', group, files: {} as Record<string, string> };
  for (const [name, bytes] of Object.entries(files)) {
    manifest.files[name] = badHash ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex');
  }
  writeFileSync(join(embedded, `assets-${group}.zip`), zipSync(files, { level: 0 }));
  writeFileSync(join(embedded, `assets-${group}.json`), JSON.stringify(manifest));
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'minions-assets-'));
  embedded = join(base, 'embedded');
  cache = join(base, 'cache');
  mkdirSync(embedded, { recursive: true });
  process.env.MINIONS_EXE = '1';
  process.env.MINIONS_EMBEDDED_DIR = embedded;
  process.env.MINIONS_CACHE_DIR = cache;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.MINIONS_EXE;
  delete process.env.MINIONS_EMBEDDED_DIR;
  delete process.env.MINIONS_CACHE_DIR;
  rmSync(base, { recursive: true, force: true });
});

describe('embedded asset extraction', () => {
  it('verifies the manifest and extracts a group into the versioned cache', async () => {
    stage('examples', { 'agent.json': Buffer.from('{"ok":true}') });
    const { ensureAssets } = await import('../src/core/embedded-assets.js');
    const root = ensureAssets('examples');
    expect(readFileSync(join(root, 'agent.json'), 'utf8')).toBe('{"ok":true}');
    expect(existsSync(join(root, '.ready'))).toBe(true);
    expect(root).toContain(join(cache, 'runtime'));
  });

  it('reuses an extracted group after a module reload without the archive', async () => {
    stage('web', { 'index.html': Buffer.from('<html>ok</html>') });
    const first = await import('../src/core/embedded-assets.js');
    const root = first.ensureAssets('web');
    rmSync(join(embedded, 'assets-web.zip'));
    vi.resetModules();
    const second = await import('../src/core/embedded-assets.js');
    expect(second.ensureAssets('web')).toBe(root);
  });

  it('rejects a checksum mismatch and leaves no ready marker', async () => {
    stage('swagger', { 'index.html': Buffer.from('<html>bad</html>') }, true);
    const { ensureAssets } = await import('../src/core/embedded-assets.js');
    expect(() => ensureAssets('swagger')).toThrow(/checksum mismatch/);
    const destination = join(cache, 'runtime', `1.0.0-${process.platform}-${process.arch}`, 'assets', 'swagger');
    expect(existsSync(join(destination, '.ready'))).toBe(false);
  });

  it('rejects path traversal entries', async () => {
    stage('native', { '../escape.txt': Buffer.from('nope') });
    const { ensureAssets } = await import('../src/core/embedded-assets.js');
    expect(() => ensureAssets('native')).toThrow(/unsafe asset path/);
    expect(existsSync(join(base, 'escape.txt'))).toBe(false);
  });
});
