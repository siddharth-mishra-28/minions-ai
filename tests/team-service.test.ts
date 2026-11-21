import { describe, expect, it, vi } from 'vitest';
import { TeamService } from '../src/systems/service.js';

/**
 * `startRun`/`resume` return before the engine finishes. The run row turns terminal
 * *before* the closing events are appended, so a process that owns the database (the
 * CLI) closes it only after `settled()` — otherwise the final write lands on a closed
 * handle and the command crashes after printing a successful summary.
 */
function harness() {
  let releaseEngine!: () => void;
  const engineFinished = new Promise<void>((resolve) => { releaseEngine = resolve; });
  const calls: string[] = [];
  const store = {
    getSystemRun: vi.fn(() => ({ id: 'team_test', status: 'running', workspace: '/tmp/ws' })),
    setRunStatus: vi.fn((_id: string, status: string) => { calls.push(`status:${status}`); }),
    appendEvent: vi.fn((event: { kind: string }) => { calls.push(`event:${event.kind}`); }),
    ...({} as Record<string, unknown>),
  };
  const engine = {
    // `resume` returns early when the engine already owns the run; this instance does not.
    isActive: () => false,
    start: vi.fn(async () => {
      await engineFinished;
      // The engine's last write happens after the status flip.
      calls.push('event:run.end');
    }),
  };
  const service = new TeamService({
    db: {} as never,
    store: store as never,
    engine: engine as never,
    workspaceRoot: '/tmp',
  });
  return { service, store, engine, calls, releaseEngine };
}

describe('TeamService.settled', () => {
  it('does not resolve while the engine is still writing', async () => {
    const { service, releaseEngine } = harness();
    service.resume('team_test');

    let done = false;
    const waiter = service.settled('team_test').then(() => { done = true; });
    await new Promise((r) => setTimeout(r, 25));
    expect(done).toBe(false);

    releaseEngine();
    await waiter;
    expect(done).toBe(true);
  });

  it('resolves immediately for a run this process is not executing', async () => {
    const { service } = harness();
    await expect(service.settled('team_other')).resolves.toBeUndefined();
  });

  it('marks the run failed when the engine rejects, then settles', async () => {
    const engineStarted = vi.fn(async () => { throw new Error('provider exploded'); });
    const store = {
      getSystemRun: () => ({ id: 'team_test', status: 'running', workspace: '/tmp/ws' }),
      setRunStatus: vi.fn(),
      appendEvent: vi.fn(),
    };
    const service = new TeamService({
      db: {} as never,
      store: store as never,
      engine: { isActive: () => false, start: engineStarted } as never,
      workspaceRoot: '/tmp',
    });
    service.resume('team_test');
    await service.settled('team_test');
    expect(store.setRunStatus).toHaveBeenCalledWith('team_test', 'failed', 'provider exploded');
    // A settled run leaves the map, so a later call is a no-op rather than a hang.
    await expect(service.settled('team_test')).resolves.toBeUndefined();
  });
});
