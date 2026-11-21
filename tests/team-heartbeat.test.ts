import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteAdapter } from '../src/store/sqlite.js';
import { TeamStore } from '../src/store/teams.js';
import { TeamEngine } from '../src/execution/team/engine.js';
import { TeamService } from '../src/systems/service.js';
import { createScriptedExecutor } from '../src/execution/team/executor.js';
import { tempWorkspace } from './team-fixtures.js';

/**
 * Liveness contract for team runs: the executing engine beats `heartbeat_at` while a
 * run is really in flight, so a booting server's stale-run recovery can tell a run
 * that crashed from one another process (e.g. `minions-assembler team run`) is still
 * executing. Stealing the latter used to kill live runs mid-node.
 */
const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows lag */ }
  }
});

function stack() {
  const dir = tempWorkspace();
  cleanups.push(dir);
  const db = new SqliteAdapter(join(dir, 'teams.db'));
  const store = new TeamStore(db);
  const engine = new TeamEngine({ store, executor: createScriptedExecutor(() => ({ text: '{"status":"done"}' })), lookup: db, workspaceRoot: dir });
  const service = new TeamService({ db, store, engine, workspaceRoot: dir });
  return { dir, db, store, engine, service };
}

function runInput(workspace: string) {
  return {
    systemId: 'delivery-team', systemName: 'Delivery Team', systemVersion: '1.0.0',
    workflowId: 'pipeline', workflowVersion: '1.0.0', mode: 'sequential',
    snapshotJson: '{}', engineVersion: 'test', task: 'ship it', workspace,
    limitsJson: '{}',
  };
}

describe('team runs — heartbeat and stale-run recovery', () => {
  it('recovers only runs whose engine stopped beating', () => {
    const s = stack();
    const live = s.store.createSystemRun(runInput(s.dir));
    const neverBeat = s.store.createSystemRun(runInput(s.dir));
    const stoppedBeating = s.store.createSystemRun(runInput(s.dir));

    s.store.touchRun(live);
    s.store.touchRun(stoppedBeating);
    s.db.raw.prepare(`UPDATE agent_system_runs SET heartbeat_at=? WHERE id=?`)
      .run(new Date(Date.now() - 6 * 60_000).toISOString(), stoppedBeating);

    // `neverBeat` (died before its first beat) and `stoppedBeating` are recoverable;
    // `live` is being executed right now and must be left alone.
    expect(s.store.staleRuns().sort()).toEqual([neverBeat, stoppedBeating].sort());

    const recovered = s.service.recoverStaleRuns().sort();
    expect(recovered).toEqual([neverBeat, stoppedBeating].sort());
    expect(String(s.store.getSystemRun(live)!.status)).toBe('queued');
    expect(String(s.store.getSystemRun(neverBeat)!.status)).toBe('interrupted');
    expect(String(s.store.getSystemRun(stoppedBeating)!.status)).toBe('interrupted');
  });

  it('the engine beats the run row while executing', async () => {
    const s = stack();
    // A heartbeat lands as soon as the engine starts, before any node work.
    const runId = s.store.createSystemRun(runInput(s.dir));
    expect(s.store.getSystemRun(runId)!.heartbeat_at ?? null).toBeNull();
    await s.engine.start(runId);
    expect(s.store.getSystemRun(runId)!.heartbeat_at ?? null).toBeTruthy();
  });
});
