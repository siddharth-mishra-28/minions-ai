import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { Badge, Button, Card, EmptyState, Select, Spinner, timeAgo } from '@/components/ui';
import { ErrorNote, Mono, OpsPage, RunStatus, Td, Th } from '@/features/ops/components';
import { teamApi, type TeamRunRow } from '@/lib/teams';

const STATUSES = ['', 'queued', 'running', 'awaiting-approval', 'interrupted', 'done', 'failed', 'stopped'];

const duration = (r: TeamRunRow): string => {
  if (!r.started_at) return '—';
  const start = new Date(r.started_at.endsWith('Z') ? r.started_at : r.started_at + 'Z').getTime();
  const end = r.finished_at ? new Date(r.finished_at.endsWith('Z') ? r.finished_at : r.finished_at + 'Z').getTime() : Date.now();
  const s = Math.max(0, Math.round((end - start) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

export default function TeamRuns() {
  const nav = useNavigate();
  const [status, setStatus] = useState('');
  const [systemId, setSystemId] = useState('');
  const teams = useQuery({ queryKey: ['teams'], queryFn: teamApi.list });
  const runs = useQuery({
    queryKey: ['team-runs', { status, systemId }],
    queryFn: () => teamApi.runs({ status: status || undefined, systemId: systemId || undefined, limit: 200 }),
    refetchInterval: 5000,
  });

  const list = runs.data ?? [];
  return (
    <OpsPage title="Team runs" description="Every orchestrated run with its pinned team version and workflow."
      actions={<div className="flex items-center gap-2">
        <Select value={systemId} onChange={(e) => setSystemId(e.target.value)} className="w-52" aria-label="Team filter">
          <option value="">All teams</option>
          {(teams.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </Select>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-44" aria-label="Status filter">
          {STATUSES.map((s) => <option key={s} value={s}>{s || 'Any status'}</option>)}
        </Select>
        <Button variant="ghost" onClick={() => void runs.refetch()}><RefreshCw className="size-4" />Refresh</Button>
        <Button variant="ghost" onClick={() => nav('/teams')}><ArrowLeft className="size-4" />Teams</Button>
      </div>}>
      <div className="space-y-4">
        <ErrorNote error={runs.error} />
        {runs.isLoading && <div className="flex justify-center py-16"><Spinner className="size-6" /></div>}
        {!runs.isLoading && list.length === 0 && (
          <EmptyState title="No team runs" description={status || systemId ? 'Nothing matches these filters.' : 'Publish a team and start a run from the Teams page.'} />
        )}
        {list.length > 0 && (
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border bg-surface-2/50">
                  <tr><Th>Run</Th><Th>Team</Th><Th>Workflow</Th><Th>Status</Th><Th>Task</Th><Th>Started</Th><Th>Duration</Th></tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {list.map((r) => (
                    <tr key={r.id} onClick={() => nav(`/team-runs/${r.id}`)} className="cursor-pointer hover:bg-surface-2/50">
                      <Td><Mono className="text-accent">{r.id}</Mono></Td>
                      <Td className="max-w-48 truncate">{r.system_name} <span className="text-xs text-muted">v{r.system_version}</span></Td>
                      <Td className="text-muted">{r.workflow_id} <Badge>{r.mode}</Badge></Td>
                      <Td><RunStatus status={r.status} /></Td>
                      <Td className="max-w-sm truncate text-muted" title={r.task}>{r.task}</Td>
                      <Td className="whitespace-nowrap text-xs text-muted">{timeAgo(r.created_at)}</Td>
                      <Td className="whitespace-nowrap text-xs text-muted">{duration(r)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
    </OpsPage>
  );
}
