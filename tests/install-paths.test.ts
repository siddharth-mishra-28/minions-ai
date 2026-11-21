import { afterEach, describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import { cacheRoot, dataDir, defaultDbPath } from '../src/core/install-paths.js';

const original = {
  MINIONS_DATA_DIR: process.env.MINIONS_DATA_DIR,
  MINIONS_CACHE_DIR: process.env.MINIONS_CACHE_DIR,
  MINIONS_EXE: process.env.MINIONS_EXE,
};

afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('install path mapping', () => {
  it('uses ./data in a source checkout', () => {
    delete process.env.MINIONS_EXE;
    delete process.env.MINIONS_DATA_DIR;
    expect(dataDir()).toBe(resolve('data'));
    expect(defaultDbPath()).toBe(join(resolve('data'), 'minion.db'));
  });

  it('honors MINIONS_DATA_DIR for both data and the default database', () => {
    const custom = resolve('custom-state');
    process.env.MINIONS_DATA_DIR = custom;
    expect(dataDir()).toBe(custom);
    expect(defaultDbPath()).toBe(join(custom, 'minion.db'));
  });

  it('honors MINIONS_CACHE_DIR regardless of packaged state', () => {
    const custom = resolve('custom-cache');
    process.env.MINIONS_CACHE_DIR = custom;
    expect(cacheRoot()).toBe(custom);
  });

  it('uses a user-writable platform directory when packaged', () => {
    process.env.MINIONS_EXE = '1';
    delete process.env.MINIONS_DATA_DIR;
    delete process.env.MINIONS_CACHE_DIR;
    const data = dataDir();
    const cache = cacheRoot();
    expect(data).not.toBe(resolve('data'));
    expect(defaultDbPath()).toBe(join(data, 'minion.db'));
    expect(cache).not.toBe(resolve('cache'));
  });
});
