import type { TeamEvent } from '../../systems/types.js';

/**
 * In-memory live-run fan-out for the cockpit. Events are already persisted by the
 * engine; this only mirrors them to connected SSE clients.
 */
export class TeamHub {
  private subs = new Map<string, Set<(event: TeamEvent) => void>>();

  subscribe(runId: string, fn: (event: TeamEvent) => void): () => void {
    const set = this.subs.get(runId) ?? new Set();
    set.add(fn);
    this.subs.set(runId, set);
    return () => {
      set.delete(fn);
      if (!set.size) this.subs.delete(runId);
    };
  }

  publish(runId: string, event: TeamEvent): void {
    for (const fn of this.subs.get(runId) ?? []) {
      try { fn(event); } catch { /* a broken client must not break the run */ }
    }
  }

  subscriberCount(runId: string): number {
    return this.subs.get(runId)?.size ?? 0;
  }
}
