import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { teamApi, type TeamEventRow } from '@/lib/teams';

/**
 * Live run timeline. Loads the persisted backlog first, then follows the SSE stream.
 * Sequence numbers de-duplicate replays: EventSource reconnects reuse the original
 * `after` cursor, so the server replays events we already have.
 */
export function useTeamEvents(runId: string) {
  const qc = useQueryClient();
  const [events, setEvents] = useState<TeamEventRow[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!runId) return;
    let closed = false;
    let es: EventSource | null = null;
    setEvents([]);
    setConnected(false);

    const merge = (incoming: TeamEventRow[]) => setEvents((prev) => {
      const seen = new Set(prev.map((e) => e.seq));
      const next = [...prev];
      for (const e of incoming) if (!seen.has(e.seq)) { seen.add(e.seq); next.push(e); }
      next.sort((a, b) => a.seq - b.seq);
      return next;
    });

    void teamApi.events(runId, 0)
      .then((backlog) => {
        if (closed) return;
        merge(backlog.events);
        es = new EventSource(`/api/team-runs/${encodeURIComponent(runId)}/stream?after=${backlog.lastSeq}`);
        es.onopen = () => setConnected(true);
        es.onmessage = (m) => {
          try {
            const ev = JSON.parse(m.data) as TeamEventRow;
            merge([ev]);
            void qc.invalidateQueries({ queryKey: ['team-run', runId] });
            if (ev.kind === 'run.complete' || ev.kind === 'run.failed' || ev.kind === 'run.stopped') {
              es?.close();
              setConnected(false);
            }
          } catch { /* ignore malformed frames */ }
        };
        es.onerror = () => setConnected(false);
      })
      .catch(() => { /* the polling query still updates the page */ });

    return () => { closed = true; es?.close(); };
  }, [runId, qc]);

  return { events, connected };
}
