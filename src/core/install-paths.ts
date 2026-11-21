import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { PKG } from './pkg.js';

/** True when running from a packaged executable (pkg or the nexe launcher). */
export function isPackaged(): boolean {
  return process.env.MINIONS_EXE === '1' || Boolean((process as unknown as { pkg?: unknown }).pkg);
}

function envDir(name: 'MINIONS_DATA_DIR' | 'MINIONS_CACHE_DIR'): string | undefined {
  const value = process.env[name]?.trim();
  return value ? resolve(value) : undefined;
}

/**
 * Persistent state: SQLite database, master key, run workspaces and team folders.
 * Development keeps the historical ./data default; packaged builds use a
 * user-writable directory so the executable can live in Program Files/Downloads.
 */
export function dataDir(): string {
  const override = envDir('MINIONS_DATA_DIR');
  if (override) return override;
  if (!isPackaged()) return resolve('./data');
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'MinionsAI');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'MinionsAI');
  }
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'minions-ai');
}

/** Disposable runtime support files (extracted native addons and the Copilot runtime). */
export function cacheRoot(): string {
  const override = envDir('MINIONS_CACHE_DIR');
  if (override) return override;
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'MinionsAI', 'cache');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Caches', 'MinionsAI');
  }
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'minions-ai');
}

/** Versioned cache shared by all asset groups. */
export function runtimeCacheDir(): string {
  return join(cacheRoot(), 'runtime', `${PKG.version}-${process.platform}-${process.arch}`);
}

/** Default SQLite path. Explicit --db still wins in every command. */
export function defaultDbPath(): string {
  return join(dataDir(), 'minion.db');
}
