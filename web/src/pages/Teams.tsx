import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { GitBranch, Layers, Play, Plus, RefreshCw, Rocket, Sparkles, Trash2, Users } from 'lucide-react';
import { Badge, Button, Card, ConfirmButton, EmptyState, Field, Modal, Select, Spinner, Textarea, timeAgo, toast } from '@/components/ui';
import { errMsg } from '@/lib/api';
import { ErrorNote, Mono, OpsPage, RunStatus, Td, Th } from '@/features/ops/components';
import { fmtNum } from '@/features/ops/lib';
import { teamApi, type TeamSummary } from '@/lib/teams';

export default function Teams() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const teams = useQuery({ queryKey: ['teams'], queryFn: teamApi.list });
  const runs = useQuery({ queryKey: ['team-runs', 'recent'], queryFn: () => teamApi.runs({ limit: 12 }), refetchInterval: 10_000 });
  const [runFor, setRunFor] = useState<TeamSummary | null>(null);
  const [workflowId, setWorkflowId] = useState('');
  const [task, setTask] = useState('');
  const [busy, setBusy] = useState(false);

  const openRun = (team: TeamSummary) => {
    setRunFor(team);
    setWorkflowId(team.workflows[0]?.workflowId ?? '');
    setTask(team.description ?? '');
  };

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['teams'] });
    void qc.invalidateQueries({ queryKey: ['team-runs'] });
  };

  const publish = async (team: TeamSummary) => {
    try { await teamApi.publish(team.id); toast.ok(`Published ${team.name}`); refresh(); }
    catch (e) { toast.error(errMsg(e)); }
  };

  const remove = async (team: TeamSummary) => {
    try { await teamApi.remove(team.id); toast.ok(`Deleted ${team.name}`); refresh(); }
    catch (e) { toast.error(errMsg(e)); }
  };

  const start = async () => {
    if (!runFor) return;
    setBusy(true);
    try {
      const started = await teamApi.startRun(runFor.id, { task: task.trim(), workflowId: workflowId || undefined });
      toast.ok(`Run started on ${started.version}`);
      setRunFor(null);
      refresh();
      nav(`/team-runs/${started.runId}`);
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  };

  const list = teams.data ?? [];
  const recent = runs.data ?? [];
  const counts = useMemo(() => ({
    members: list.reduce((n, t) => n + t.members.length, 0),
    workflows: list.reduce((n, t) => n + t.workflows.length, 0),
  }), [list]);

  return (
    <OpsPage title="Agent teams" description="Assemble independently versioned agents into workflows, publish immutable versions and watch them work."
      actions={<>
        <Button onClick={() => nav('/chat?agent=team-author@builtin')} title="Describe the team you want — the designer composes it from registered agents"><Sparkles className="size-4" />Design with AI</Button>
        <Button variant="primary" onClick={() => nav('/teams/new')}><Plus className="size-4" />New team</Button>
      </>}>
      <div className="space-y-6">
        <ErrorNote error={teams.error ?? runs.error} />
        {teams.isLoading && <div className="flex justify-center py-16"><Spinner className="size-6" /></div>}
        {!teams.isLoading && list.length === 0 && (
          <EmptyState icon={<Users className="size-6" />} title="No teams yet"
            description="A team references existing agents by pinned version and adds roles, workflows and delegation. Individual agent definitions stay untouched."
            action={<div className="flex gap-2">
              <Button variant="primary" onClick={() => nav('/teams/new')}><Plus className="size-4" />Design a team</Button>
              <Button onClick={() => nav('/agents')}><Layers className="size-4" />See agents</Button>
            </div>} />
        )}
        {list.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <Badge tone="accent">{list.length} team{list.length === 1 ? '' : 's'}</Badge>
            <span>{counts.members} member assignments · {counts.workflows} workflows</span>
            <Button size="sm" variant="ghost" onClick={refresh} className="ml-auto"><RefreshCw className="size-3.5" />Refresh</Button>
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          {list.map((t) => (
            <Card key={t.id} className="flex flex-col p-4">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent"><Users className="size-5" /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link to={`/teams/${encodeURIComponent(t.id)}/edit`} className="truncate text-sm font-semibold hover:underline">{t.name}</Link>
                    {t.currentVersion ? <Badge tone="ok">v{t.currentVersion}</Badge> : <Badge tone="warn">draft</Badge>}
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted">{t.description || 'No description'}</p>
                  <div className="mt-1 font-mono text-[11px] text-muted">{t.id}</div>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-1.5">
                {t.members.map((m) => (
                  <span key={m.memberId} title={`${m.role} · ${m.agentId}${m.pinned ? ' (pinned)' : ' (unpinned)'}`}>
                    <Badge tone={m.pinned ? 'neutral' : 'warn'}>{m.role}</Badge>
                  </span>
                ))}
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {t.workflows.map((w) => (
                  <Link key={w.workflowId} to={`/teams/${encodeURIComponent(t.id)}/edit?workflow=${encodeURIComponent(w.workflowId)}`}>
                    <Badge tone="accent"><GitBranch className="size-3" />{w.name} · {w.mode}</Badge>
                  </Link>
                ))}
              </div>

              <div className="mt-3 flex items-center justify-between text-xs text-muted">
                <span>{fmtNum(t.runCount)} run{t.runCount === 1 ? '' : 's'}{t.lastRunAt ? ` · last ${timeAgo(t.lastRunAt)}` : ''}</span>
                <span>updated {timeAgo(t.updatedAt)}</span>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-1.5 border-t border-border pt-3">
                <Button size="sm" variant="primary" disabled={!t.currentVersion} title={t.currentVersion ? 'Start a run' : 'Publish this team first'} onClick={() => openRun(t)}>
                  <Play className="size-3.5" />Run
                </Button>
                <Button size="sm" onClick={() => nav(`/teams/${encodeURIComponent(t.id)}/edit`)}>Design</Button>
                <Button size="sm" variant="ghost" onClick={() => void publish(t)} title="Publish the current draft as a new immutable version">
                  <Rocket className="size-3.5" />Publish
                </Button>
                <span className="ml-auto">
                  <ConfirmButton size="sm" confirmLabel="Delete?" aria-label={`Delete ${t.id}`} onConfirm={() => void remove(t)}><Trash2 className="size-3.5" /></ConfirmButton>
                </span>
              </div>
            </Card>
          ))}
        </div>

        <section>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Recent team runs</h2>
            <Link to="/team-runs" className="text-xs text-accent hover:underline">All team runs</Link>
          </div>
          {runs.isLoading ? <Spinner className="size-4" /> : recent.length === 0 ? (
            <Card className="px-4 py-8 text-center text-sm text-muted">No team runs yet. Publish a team, then start one.</Card>
          ) : (
            <Card className="overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-border bg-surface-2/50"><tr><Th>Run</Th><Th>Team</Th><Th>Workflow</Th><Th>Status</Th><Th>Started</Th></tr></thead>
                  <tbody className="divide-y divide-border">
                    {recent.map((r) => (
                      <tr key={r.id} onClick={() => nav(`/team-runs/${r.id}`)} className="cursor-pointer hover:bg-surface-2/50">
                        <Td><Mono className="text-accent">{r.id}</Mono></Td>
                        <Td className="max-w-40 truncate">{r.system_name} <span className="text-xs text-muted">v{r.system_version}</span></Td>
                        <Td className="text-muted">{r.workflow_id} <span className="text-xs">({r.mode})</span></Td>
                        <Td><RunStatus status={r.status} /></Td>
                        <Td className="whitespace-nowrap text-muted">{timeAgo(r.created_at)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </section>
      </div>

      <Modal open={!!runFor} onClose={() => setRunFor(null)} title={`Run ${runFor?.name ?? ''}`}
        footer={<><Button variant="ghost" onClick={() => setRunFor(null)}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!task.trim()} onClick={() => void start()}><Play className="size-4" />Start run</Button></>}>
        <div className="space-y-3">
          <p className="text-xs text-muted">The run is pinned to published version <Mono>v{runFor?.currentVersion}</Mono>. Every member's definition hash, workflow graph and limits are snapshotted at start.</p>
          <Field label="Workflow">
            <Select value={workflowId} onChange={(e) => setWorkflowId(e.target.value)} aria-label="Workflow">
              {(runFor?.workflows ?? []).map((w) => <option key={w.workflowId} value={w.workflowId}>{w.name} · {w.mode}</option>)}
            </Select>
          </Field>
          <Field label="Team objective" hint="Handed to the entry member as the run task.">
            <Textarea rows={5} value={task} onChange={(e) => setTask(e.target.value)} placeholder="Describe what the team should deliver…" />
          </Field>
        </div>
      </Modal>
    </OpsPage>
  );
}

