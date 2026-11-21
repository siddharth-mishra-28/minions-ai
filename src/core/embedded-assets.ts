import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { unzipSync } from 'fflate';
import { isPackaged, runtimeCacheDir } from './install-paths.js';
import { moduleDir } from './module-path.js';

export type AssetGroup = 'web' | 'examples' | 'swagger' | 'native' | 'copilot';

interface AssetManifest {
  version: string;
  group: AssetGroup;
  files: Record<string, string>;
}

const resolved = new Map<AssetGroup, string>();
const PLATFORM = `${process.platform}-${process.arch}`;
const HERE = moduleDir(import.meta.url);

/** Where a group lives in a source checkout (no embedded archive). */
function devGroup(group: AssetGroup): string {
  switch (group) {
    case 'web': return resolve('dist', 'web');
    case 'examples': return resolve('examples');
    case 'swagger': return resolve('node_modules', '@fastify', 'swagger-ui', 'static');
    case 'native': return resolve('node_modules', 'better-sqlite3', 'prebuilds', `${PLATFORM}.node`);
    case 'copilot': return resolve('node_modules', `@github/copilot-sdk-${PLATFORM}`);
  }
}

/** Find a resource inside the packaged snapshot or the local build staging dir. */
function embeddedPath(name: string): string | undefined {
  const candidates = [
    process.env.MINIONS_EMBEDDED_DIR ? join(process.env.MINIONS_EMBEDDED_DIR, name) : '',
    join(HERE, 'assets', name),
    join(process.cwd(), 'build', 'exe', 'assets', name),
    join('/snapshot', 'build', 'exe', 'assets', name),
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate));
}

function readManifest(group: AssetGroup): AssetManifest {
  const path = embeddedPath(`assets-${group}.json`);
  if (!path) throw new Error(`packaged asset manifest missing for ${group}`);
  return JSON.parse(readFileSync(path, 'utf8')) as AssetManifest;
}

function verify(file: string, expected: string): void {
  const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (actual !== expected) throw new Error(`asset checksum mismatch: ${file}`);
}

/**
 * Return a real directory/file for an asset group, extracting the embedded zip once.
 * Extraction is staged in a sibling temp directory and renamed atomically, so a
 * crash cannot leave a half-extracted native addon in place.
 */
export function ensureAssets(group: AssetGroup): string {
  const cached = resolved.get(group);
  if (cached) return cached;

  if (!isPackaged()) {
    const dev = devGroup(group);
    resolved.set(group, dev);
    return dev;
  }

  const root = join(runtimeCacheDir(), 'assets');
  const destination = join(root, group);
  const marker = join(destination, '.ready');
  if (existsSync(marker)) {
    resolved.set(group, destination);
    return destination;
  }

  const zipPath = embeddedPath(`assets-${group}.zip`);
  if (!zipPath) throw new Error(`packaged assets missing for ${group}`);
  const manifest = readManifest(group);
  const files = unzipSync(readFileSync(zipPath));
  const staging = `${destination}.tmp-${process.pid}-${Date.now()}`;
  mkdirSync(staging, { recursive: true });
  try {
    for (const [relative, bytes] of Object.entries(files)) {
      if (relative.includes('..') || relative.startsWith('/') || relative.startsWith('\\')) {
        throw new Error(`unsafe asset path: ${relative}`);
      }
      const target = join(staging, relative);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
      const expected = manifest.files[relative];
      if (expected) verify(target, expected);
      if (relative === 'better_sqlite3.node' || relative.endsWith('/copilot-runtime') || relative.endsWith('/copilot-runtime.exe')) {
        try { chmodSync(target, 0o755); } catch { /* Windows */ }
      }
    }
    writeFileSync(join(staging, '.ready'), new Date().toISOString());
    rmSync(destination, { recursive: true, force: true });
    mkdirSync(dirname(destination), { recursive: true });
    renameSync(staging, destination);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  resolved.set(group, destination);
  return destination;
}
