import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter } from '../src/store/sqlite.js';
import { PlatformStore } from '../src/store/platform.js';
import { TeamStore } from '../src/store/teams.js';
import { runInit } from '../src/onboarding/init.js';
import { resetDatabase } from '../src/onboarding/reset.js';

const dirs: string[] = [];
const makeDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'onboarding-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  delete process.env.MINIONS_DATA_DIR;
  for (const dir of dirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows lag */ }
  }
});

describe('first-run init and new-install reset', () => {
  it('stores a provider key encrypted, seeds the base agent and the sample team, then resets to a new installation', async () => {
    const dir = makeDir();
    process.env.MINIONS_DATA_DIR = dir;
    const dbPath = join(dir, 'minion.db');

    const result = await runInit({
      dbPath,
      provider: 'xiaomi',
      apiKey: 'sk-unit-test-not-a-real-key',
      skipTest: true,
      interactive: false,
    });
    expect(result.providerName).toBe('Xiaomi MiMo');
    expect(result.tested).toBe(false);
    expect(result.seededAgents).toEqual([
      'architect@1.0.0', 'full-stack-developer@1.0.0', 'manager@1.0.0', 'qe-engineer@1.0.0', 'requirements-analyst@1.0.0',
    ]);
    expect(result.seededTeams.map((t) => `${t.id}@${t.version}`)).toEqual(['software-delivery-team@2.0.0']);

    const db = new SqliteAdapter(dbPath);
    try {
      const platform = new PlatformStore(db);
      const provider = platform.getDefaultProvider();
      expect(provider?.id).toBe(result.providerId);
      expect(provider?.hasKey).toBe(true);
      expect(platform.getProviderSecret(result.providerId)).toBe('sk-unit-test-not-a-real-key');
      expect(platform.getSettings().onboarding.completed).toBe(true);
      expect(platform.getSettings().defaults.model).toBe('mimo-v2.6-flash');

      const agents = db.listAgents();
      expect(agents).toHaveLength(5);
      const seededRows = new Map(agents.map((a) => [a.id, db.getAgent(a.id) as { definition_json: string; definition_hash: string }]));
      const definition = JSON.parse(seededRows.get('manager@1.0.0')!.definition_json) as { provider: { providerRef?: string } };
      expect(definition.provider.providerRef).toBe(result.providerId);

      // The sample team is published and runnable on a fresh install, pinned to the
      // agent definitions that actually live in this database (not the file hashes).
      const teams = new TeamStore(db);
      const system = teams.getSystem('software-delivery-team');
      expect(system?.status).toBe('published');
      expect(system?.current_version).toBe('2.0.0');
      const published = teams.getSystemVersion('software-delivery-team', '2.0.0');
      expect(published).toBeTruthy();
      const memberPins = (JSON.parse(published!.definitionJson) as { team: { members: { memberId: string; agentRef: { agentId: string; definitionHash?: string } }[] } })
        .team.members.map((m) => ({ memberId: m.memberId, hash: m.agentRef.definitionHash, agentId: m.agentRef.agentId }));
      expect(new Set(memberPins.map((p) => p.hash)).size).toBe(5);
      for (const p of memberPins) {
        expect(p.hash).toBe(`sha256:${seededRows.get(p.agentId)!.definition_hash}`);
      }
      expect(teams.listWorkflowVersions('software-delivery-team')).toHaveLength(2);
    } finally {
      db.close();
    }
    expect(existsSync(join(dir, '.master-key'))).toBe(true);

    const reset = resetDatabase({
      dbPath,
      workspaceRoot: dir,
      dataDir: dir,
      newInstall: true,
      seedDefaults: true,
      backup: true,
    });
    expect(reset.backupPath).toBeTruthy();
    expect(reset.masterKeyRemoved).toBe(true);
    expect(reset.seededAgents).toEqual(['architect@1.0.0', 'full-stack-developer@1.0.0', 'manager@1.0.0', 'qe-engineer@1.0.0', 'requirements-analyst@1.0.0']);
    expect(reset.seededTeams).toHaveLength(1);
    expect(reset.tables.providers).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(dir, '.master-key'))).toBe(false);

    const after = new SqliteAdapter(dbPath);
    try {
      const platform = new PlatformStore(after);
      expect(platform.listProviders()).toHaveLength(0);
      expect(platform.getSettings().onboarding.completed).toBe(false);
      expect(after.listAgents()).toHaveLength(5);
      const present = new Set(
        (after.raw.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((r) => r.name),
      );
      // Runs, messages, chats and memories are empty; only the shipped sample team row
      // and its published versions survive, because they are part of a new install.
      const counts = ['agent_system_runs', 'agent_run_messages', 'runs', 'chat_threads', 'mem_nodes']
        .filter((t) => present.has(t))
        .map((t) => (after.raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
      expect(counts.every((n) => n === 0)).toBe(true);
      expect((after.raw.prepare(`SELECT COUNT(*) AS n FROM agent_systems`).get() as { n: number }).n).toBe(1);
    } finally {
      after.close();
    }

    // A second init after the reset must create a fresh key and seal the new secret.
    const second = await runInit({
      dbPath,
      provider: 'xiaomi',
      apiKey: 'sk-second-key',
      skipTest: true,
      interactive: false,
    });
    expect(second.created).toBe(true);
    expect(existsSync(join(dir, '.master-key'))).toBe(true);
    const finalDb = new SqliteAdapter(dbPath);
    try {
      const platform = new PlatformStore(finalDb);
      expect(platform.getDefaultProvider()?.hasKey).toBe(true);
      expect(platform.getProviderSecret(second.providerId)).toBe('sk-second-key');
    } finally {
      finalDb.close();
    }
  });
});
