import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import {
  ArrowLeft, ArrowRight, Download, GitBranch, MessageSquare, RotateCcw, Send, Square, Users,
} from 'lucide-react';
import { Badge, Button, Card, Field, Select, Spinner, Tabs, Textarea, cn, timeAgo, toast } from '@/components/ui';
import { CodeBlock, CopyButton, ErrorNote, Mono, OpsPage, RunStatus, Stat, Td, Th } from '@/features/ops/components';
import { downloadFromApi, fmtDate, fmtDuration, fmtNum, parseTs, pretty } from '@/features/ops/lib';
import { useTeamEvents } from '@/features/teams/useTeamEvents';
import { isTerminal, teamApi, type NodeRunRow, type TeamEventRow, type TeamMessageType } from '@/lib/teams';
import { errMsg } from '@/lib/api';

type Tab = 'overview' | 'conversation' | 'a2a' | 'deliverables' | 'timeline' | 'snapshot';

const MESSAGE_TYPES: TeamMessageType[] = ['message', 'clarification', 'task-request', 'review-request', 'review-response', 'decision', 'handoff', 'status-update', 'escalation', 'proposal'];
const levelTone = (level: string) => (level === 'error' ? 'danger' : level === 'warn' ? 'warn' : 'neutral');

const nodeTone = (s: string): 'ok' | 'warn' | 'danger' | 'neutral' | 'accent' =>
  s === 'done' ? 'ok' : s === 'failed' ? 'danger' : s === 'running' ? 'accent' : s === 'waiting' ? 'warn' : 'neutral';

const parseOutput = (json: string | null): { status?: string; summary?: string; artifacts?: unknown[] } | null => {
  if (!json) return null;
  try { return JSON.parse(json) as { status?: string; summary?: string; artifacts?: unknown[] }; } catch { return null; }
};

const nodeDuration = (n: NodeRunRow): number | null => {
  const start = parseTs(n.started_at);
  const end = n.finished_at ? parseTs(n.finished_at) : Date.now();
  return Number.isNaN(start) || Number.isNaN(end) ? null : Math.max(0, end - start);
};

export default function TeamRun() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('overview');
  const [to, setTo] = useState('team');
  const [type, setType] = useState<TeamMessageType>('message');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msgFilter, setMsgFilter] = useState<'milestones' | 'all'>('milestones');

  const query = useQuery({
    queryKey: ['team-run', id],
    queryFn: () => teamApi.run(id),
    refetchInterval: (q) => (isTerminal(q.state.data?.run.status) ? false : 1500),
  });
  const { events, connected } = useTeamEvents(id);
  const messages = useQuery({
    queryKey: ['team-messages', id],
    queryFn: () => teamApi.messages(id),
    refetchInterval: query.data && !isTerminal(query.data.run.status) ? 4000 : false,
  });

  const run = query.data?.run;
  const snapshot = query.data?.snapshot;
  const live = !!run && !isTerminal(run.status);
  const roles = useMemo(() => new Map((snapshot?.resolvedMembers ?? []).map((m) => [m.memberId, m.role])), [snapshot]);

  const pendingApproval = useMemo(() => {
    const requested = [...events].reverse().find((e) => e.kind === 'approval.requested');
    if (!requested) return null;
    const decided = events.some((e) => e.kind === 'approval.decision' && e.seq > requested.seq);
    return decided ? null : requested;
  }, [events]);

  const memberIds = useMemo(() => (snapshot?.resolvedMembers ?? []).map((m) => m.memberId), [snapshot]);
  const nodes = query.data?.nodes ?? [];
  const artifacts = query.data?.artifacts ?? [];
  const handoffs = query.data?.handoffs ?? [];
  const progress = query.data?.progress ?? [];
  const progressByMember = useMemo(() => new Map(progress.map((p) => [p.member_id, p])), [progress]);
  const conversation = useMemo(() => {
    const all = messages.data?.messages ?? [];
    return msgFilter === 'all' ? all : all.filter((m) => m.type !== 'status-update');
  }, [messages.data, msgFilter]);
  const a2aOrigin = typeof window === 'undefined' ? '' : window.location.origin;
  const teamCardUrl = `${a2aOrigin}/a2a/${encodeURIComponent(run?.system_id ?? '')}/.well-known/agent-card.json`;

  const act = async (label: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(label);
    try {
      await fn();
      toast.ok(ok);
      await qc.invalidateQueries({ queryKey: ['team-run', id] });
      await qc.invalidateQueries({ queryKey: ['team-messages', id] });
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(null); }
  };

  const send = async () => {
    const text = body.trim();
    if (!text) return;
    const targets = to === 'team' ? memberIds : [to];
    await act('send', () => teamApi.sendMessage(id, { to: targets, body: text, type }), 'Message delivered to the team conversation');
    setBody('');
  };

  if (query.isLoading) return <OpsPage title="Team run"><div className="flex justify-center py-24"><Spinner className="size-6" /></div></OpsPage>;
  if (query.error || !run || !query.data) {
    return <OpsPage title="Team run" actions={<Button variant="ghost" onClick={() => nav('/team-runs')}><ArrowLeft className="size-4" />Team runs</Button>}>
      <ErrorNote error={query.error ?? `No team run with id ${id}.`} />
    </OpsPage>;
  }

  const actions = (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="ghost" onClick={() => nav('/team-runs')}><ArrowLeft className="size-4" />Runs</Button>
      <Button variant="ghost" onClick={() => nav(`/teams/${encodeURIComponent(run.system_id)}/edit`)}><Users className="size-4" />Team</Button>
      {live && <Button variant="danger" loading={busy === 'stop'} onClick={() => void act('stop', () => teamApi.stop(id), 'Stop requested')}><Square className="size-3.5" />Stop</Button>}
      {run.status === 'interrupted' || run.status === 'failed' ? (
        <Button variant="secondary" loading={busy === 'resume'} onClick={() => void act('resume', () => teamApi.resume(id), 'Resume requested')}><RotateCcw className="size-4" />Resume</Button>
      ) : null}
      <Button variant="secondary" onClick={() => void downloadFromApi(teamApi.exportUrl(id), `team-run-${id}.json`).catch((e) => toast.error(errMsg(e)))}>
        <Download className="size-4" />Export
      </Button>
    </div>
  );

  const outputOf = (n: NodeRunRow) => parseOutput(n.output_json);

  return (
    <OpsPage title={`${run.system_name} · ${run.workflow_id}`} description={run.id} actions={actions}>
      <div className="space-y-5">
        <Card className="p-4">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <RunStatus status={run.status} />
            <Badge tone="accent">{run.mode}</Badge>
            <Badge>v{run.system_version}</Badge>
            <Badge>{run.workflow_id} · v{run.workflow_version}</Badge>
            {live && <Badge tone={connected ? 'ok' : 'warn'}>{connected ? 'live' : 'polling'}</Badge>}
            <span className="text-xs text-muted">started {timeAgo(run.created_at)}</span>
            <Link to={`/teams/${encodeURIComponent(run.system_id)}`} className="ml-auto text-xs text-accent hover:underline" onClick={(e) => { e.preventDefault(); nav(`/teams/${encodeURIComponent(run.system_id)}/edit`); }}>
              Open team design
            </Link>
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-4">
            <Meta label="Team">{run.system_name}</Meta>
            <Meta label="Pinned version">{run.system_version}</Meta>
            <Meta label="Workflow">{run.workflow_id} ({run.mode})</Meta>
            <Meta label="Objects">{nodes.length} node runs · {query.data.messageCount} messages</Meta>
            <Meta label="Workspace"><Mono>{run.workspace}</Mono></Meta>
            <Meta label="Started">{fmtDate(run.started_at ?? run.created_at)}</Meta>
            <Meta label="Finished">{run.finished_at ? fmtDate(run.finished_at) : '—'}</Meta>
            <Meta label="Run id"><Mono>{run.id}</Mono></Meta>
          </div>
          {run.error && <div className="mt-4 rounded-lg border border-danger/30 bg-danger/10 p-3"><div className="mb-1 text-xs font-semibold uppercase tracking-wider text-danger">Error</div><pre className="whitespace-pre-wrap break-words font-mono text-xs text-danger">{run.error}</pre></div>}
        </Card>

        {pendingApproval && (
          <Card className="border-warn/40 bg-warn/5 p-4">
            <div className="flex flex-wrap items-center gap-3">
              <Badge tone="warn">human approval</Badge>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{String(pendingApproval.payload.prompt ?? 'Approve to continue')}</div>
                <div className="text-xs text-muted">node <Mono>{String(pendingApproval.payload.nodeId ?? pendingApproval.nodeId ?? '')}</Mono> · requesting member {pendingApproval.memberId ?? '—'}</div>
              </div>
              <Button variant="primary" loading={busy === 'approve'} onClick={() => void act('approve', () => teamApi.decideApproval(id, String(pendingApproval.payload.nodeId ?? pendingApproval.nodeId), 'approved'), 'Approved')}>Approve</Button>
              <Button variant="danger" loading={busy === 'reject'} onClick={() => void act('reject', () => teamApi.decideApproval(id, String(pendingApproval.payload.nodeId ?? pendingApproval.nodeId), 'rejected', 'rejected from cockpit'), 'Rejected')}>Reject</Button>
            </div>
          </Card>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Tabs value={tab} onChange={setTab} items={[
            { id: 'overview', label: 'Execution' },
            { id: 'conversation', label: `Conversation (${query.data.messageCount})` },
            { id: 'a2a', label: 'A2A' },
            { id: 'deliverables', label: `Deliverables (${artifacts.length})` },
            { id: 'timeline', label: `Timeline (${events.length})` },
            { id: 'snapshot', label: 'Snapshot' },
          ]} />
        </div>

        {tab === 'overview' && (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Node runs" value={fmtNum(nodes.length)} hint={`${nodes.filter((n) => n.status === 'done').length} done`} />
              <Stat label="Deliverables" value={fmtNum(artifacts.length)} hint={`${handoffs.length} handoffs`} />
              <Stat label="Messages" value={fmtNum(query.data.messageCount)} hint={`${events.filter((e) => e.kind === 'message.sent').length} sent by agents`} />
              <Stat label="Sessions" value={fmtNum(query.data.sessions.length)} hint="independent Copilot sessions" />
            </div>

            <section>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold">Team progress</h3>
                  <p className="text-xs text-muted">Live per-member state. Status lives here, not in the conversation.</p>
                </div>
                <Badge tone="accent">{run.mode === 'sequential' ? 'linear stages' : run.mode === 'hierarchical' ? 'manager rounds' : run.mode}</Badge>
              </div>
              <Card className="divide-y divide-border">
                {(snapshot?.resolvedMembers ?? []).map((m) => {
                  const p = progressByMember.get(m.memberId);
                  const percent = p?.percent ?? 0;
                  const memberNodes = nodes.filter((n) => n.member_id === m.memberId);
                  const done = memberNodes.filter((n) => n.status === 'done').length;
                  return (
                    <div key={m.memberId} className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{m.role}</span>
                        <Mono className="text-[11px]">{m.memberId}</Mono>
                        <Badge tone={p?.status === 'failed' || p?.status === 'blocked' ? 'danger' : p?.status === 'done' ? 'ok' : p?.status === 'working' ? 'accent' : 'neutral'}>
                          {p?.status ?? 'waiting'}
                        </Badge>
                        {p?.phase && <span className="text-xs text-muted">{p.phase}</span>}
                        <span className="ml-auto text-xs text-muted">{percent}% · {done}/{memberNodes.length} nodes</span>
                      </div>
                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2">
                        <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${Math.max(2, percent)}%` }} />
                      </div>
                      {p?.summary && <p className="mt-1.5 line-clamp-2 text-xs text-muted">{p.summary}</p>}
                    </div>
                  );
                })}
                {(snapshot?.resolvedMembers ?? []).length === 0 && <div className="px-4 py-6 text-center text-sm text-muted">No members resolved yet.</div>}
              </Card>
            </section>

            <Card className="p-4">
              <div className="mb-2 flex items-center justify-between"><h3 className="text-sm font-semibold">Objective</h3><CopyButton text={run.task} /></div>
              <p className="whitespace-pre-wrap text-sm text-muted">{run.task}</p>
            </Card>

            <section>
              <h3 className="mb-2 text-sm font-semibold">Execution tree</h3>
              {nodes.length === 0 ? <Card className="px-4 py-8 text-center text-sm text-muted">No node has executed yet.</Card> : (
                <div className="space-y-2">
                  {nodes.map((n, i) => {
                    const out = outputOf(n);
                    return (
                      <Card key={n.id} className="p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="w-6 text-center text-xs text-muted">{i + 1}</span>
                          <Badge tone={nodeTone(n.status)}>{n.status}</Badge>
                          <span className="text-sm font-semibold">{n.node_id}</span>
                          {n.member_id && <Badge tone="accent">{roles.get(n.member_id) ?? n.member_id}</Badge>}
                          <span className="text-xs text-muted">attempt {n.attempt} · iteration {n.iteration}</span>
                          <span className="ml-auto text-xs text-muted">{fmtDuration(nodeDuration(n))}</span>
                          {n.run_id && <Link to={`/runs/${n.run_id}`} className="text-xs text-accent hover:underline">agent run</Link>}
                        </div>
                        {n.task && <p className="mt-1.5 line-clamp-2 text-xs text-muted">{n.task}</p>}
                        {out?.summary && <p className="mt-1 text-xs">{out.summary}</p>}
                        {out?.status && <div className="mt-1 text-[11px] text-muted">output status: <Mono>{out.status}</Mono>{out.artifacts?.length ? ` · ${out.artifacts.length} artifact(s)` : ''}</div>}
                        {n.error && <p className="mt-1 whitespace-pre-wrap text-xs text-danger">{n.error}</p>}
                      </Card>
                    );
                  })}
                </div>
              )}
            </section>

            <div className="grid gap-4 lg:grid-cols-2">
              <Card className="p-4">
                <h3 className="mb-2 text-sm font-semibold">Pinned team</h3>
                <ul className="space-y-1.5 text-sm">
                  {(snapshot?.resolvedMembers ?? []).map((m) => (
                    <li key={m.memberId} className="flex items-center gap-2">
                      <Badge>{m.role}</Badge>
                      <Mono>{m.agentId}</Mono>
                      <span className="ml-auto font-mono text-[11px] text-muted" title={m.definitionHash}>{m.definitionHash.slice(0, 18)}…</span>
                    </li>
                  ))}
                  {(snapshot?.addedMembers ?? []).map((m) => (
                    <li key={m.memberId} className="flex items-center gap-2">
                      <Badge tone="warn">{m.role}</Badge>
                      <Mono>{m.agentId}</Mono>
                      <Badge tone="accent">added at runtime</Badge>
                    </li>
                  ))}
                </ul>
                {snapshot && (
                  <p className="mt-3 text-xs text-muted">Engine {snapshot.engineVersion} · workflow hash {snapshot.workflowDefinitionHash.slice(0, 18)}…</p>
                )}
              </Card>
              <Card className="p-4">
                <h3 className="mb-2 text-sm font-semibold">Sessions</h3>
                <ul className="space-y-1.5 text-sm">
                  {query.data.sessions.map((s) => (
                    <li key={s.member_id} className="flex items-center gap-2">
                      <Badge tone="accent">{roles.get(s.member_id) ?? s.member_id}</Badge>
                      <Mono className="truncate">{s.copilot_session_id}</Mono>
                      <span className="ml-auto text-xs text-muted">{timeAgo(s.last_used_at)}</span>
                    </li>
                  ))}
                  {query.data.sessions.length === 0 && <li className="text-sm text-muted">No sessions recorded.</li>}
                </ul>
              </Card>
            </div>

            <section>
              <h3 className="mb-2 text-sm font-semibold">Handoffs</h3>
              <Card className="overflow-hidden">
                {handoffs.length === 0 ? <div className="px-4 py-6 text-center text-sm text-muted">No handoffs yet.</div> : (
                  <table className="w-full text-sm">
                    <thead className="border-b border-border bg-surface-2/50"><tr><Th>From</Th><Th>To</Th><Th>Status</Th><Th>Summary</Th><Th>Created</Th></tr></thead>
                    <tbody className="divide-y divide-border">
                      {handoffs.map((h) => (
                        <tr key={h.id}>
                          <Td>{h.from_member}</Td><Td>{h.to_member}</Td>
                          <Td><Badge tone={h.status === 'accepted' ? 'ok' : h.status === 'rejected' ? 'danger' : 'warn'}>{h.status}</Badge></Td>
                          <Td className="max-w-md truncate text-muted" title={h.summary ?? ''}>{h.summary ?? '—'}</Td>
                          <Td className="whitespace-nowrap text-xs text-muted">{timeAgo(h.created_at)}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            </section>
          </div>
        )}

        {tab === 'conversation' && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="accent">A2A channel</Badge>
                <span className="text-xs text-muted">
                  Concise agent-to-agent messages, delivered on the recipient's next turn.{' '}
                  {snapshot?.communication?.verbosity ? `Budget: ${snapshot.communication.maxMessagesPerTurn} msg/turn, ${snapshot.communication.maxBodyChars} chars.` : ''}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <Button size="sm" variant={msgFilter === 'milestones' ? 'secondary' : 'ghost'} onClick={() => setMsgFilter('milestones')}>Milestones</Button>
                <Button size="sm" variant={msgFilter === 'all' ? 'secondary' : 'ghost'} onClick={() => setMsgFilter('all')}>All</Button>
                <CopyButton text={() => messages.data?.markdown ?? ''} label="Copy transcript" />
              </div>
            </div>
            <Card className="divide-y divide-border">
              {conversation.length === 0 && <div className="px-4 py-8 text-center text-sm text-muted">{msgFilter === 'milestones' ? 'No milestone messages yet. Progress updates are on the board.' : 'No messages yet.'}</div>}
              {conversation.map((m) => (
                <div key={m.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                    <span className="text-sm font-medium text-fg">{m.from_member === 'operator' ? 'Operator' : roles.get(m.from_member) ?? m.from_member}</span>
                    <ArrowRight className="size-3" />
                    <span>{m.to_members.length === memberIds.length ? 'team' : m.to_members.map((t) => roles.get(t) ?? t).join(', ')}</span>
                    <Badge tone={m.type === 'clarification' ? 'warn' : m.type === 'decision' ? 'ok' : m.type === 'review-request' ? 'accent' : 'neutral'}>{m.type}</Badge>
                    {m.protocol === 'a2a' && <Badge tone="accent">A2A</Badge>}
                    <span className="ml-auto">{timeAgo(m.updated_at ?? m.created_at)}</span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-sm">{m.body}</p>
                  {m.updated_at && m.updated_at !== m.created_at && <div className="mt-1 text-[11px] text-muted">updated in place</div>}
                </div>
              ))}
            </Card>
            <Card className="p-4">
              <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold"><MessageSquare className="size-4" />Send a message</h3>
              <div className="grid gap-2 sm:grid-cols-2">
                <Field label="To">
                  <Select value={to} onChange={(e) => setTo(e.target.value)}>
                    <option value="team">Whole team</option>
                    {memberIds.map((id2) => <option key={id2} value={id2}>{roles.get(id2) ?? id2}</option>)}
                  </Select>
                </Field>
                <Field label="Type">
                  <Select value={type} onChange={(e) => setType(e.target.value as TeamMessageType)}>
                    {MESSAGE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </Select>
                </Field>
              </div>
              <div className="mt-2 flex items-end gap-2">
                <Textarea rows={2} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Ask for a status update or give the team a decision…" />
                <Button variant="primary" loading={busy === 'send'} disabled={!body.trim()} onClick={() => void send()}><Send className="size-4" />Send</Button>
              </div>
              {run.status === 'awaiting-approval' && <p className="mt-2 text-xs text-warn">The run is waiting on the approval gate above; messages are queued in the conversation.</p>}
            </Card>
          </div>
        )}

        {tab === 'a2a' && (
          <div className="space-y-4">
            <Card className="p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="ok">A2A 0.3 JSON-RPC</Badge>
                <h3 className="text-sm font-semibold">Agent cards and transport</h3>
                <span className="ml-auto text-xs text-muted">Loopback-only{snapshot ? '' : ''}</span>
              </div>
              <p className="mt-2 text-xs text-muted">
                This run's team exposes the Agent2Agent protocol. Clients can discover the card, then call
                {' '}<Mono>message/send</Mono>, <Mono>message/stream</Mono>, <Mono>tasks/get</Mono> or <Mono>tasks/cancel</Mono>.
              </p>
              <div className="mt-3 space-y-2">
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-2/40 px-3 py-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted">Team card</span>
                  <Mono className="min-w-0 flex-1 truncate text-xs">{teamCardUrl}</Mono>
                  <CopyButton text={() => teamCardUrl} label="Copy" />
                </div>
                {(snapshot?.resolvedMembers ?? []).map((m) => {
                  const url = `${a2aOrigin}/a2a/${encodeURIComponent(run.system_id)}/members/${encodeURIComponent(m.memberId)}/.well-known/agent-card.json`;
                  return (
                    <div key={m.memberId} className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-2/40 px-3 py-2">
                      <Badge>{m.role}</Badge>
                      <Mono className="min-w-0 flex-1 truncate text-xs">{url}</Mono>
                      <CopyButton text={() => url} label="Copy" />
                    </div>
                  );
                })}
              </div>
            </Card>
            <Card className="p-4">
              <h3 className="mb-2 text-sm font-semibold">Send a message to this run</h3>
              <CodeBlock maxHeight="max-h-96" text={JSON.stringify({
                jsonrpc: '2.0', id: 'req-1', method: 'message/send',
                params: {
                  message: {
                    kind: 'message', messageId: 'msg-1', role: 'user',
                    contextId: run.id,
                    parts: [{ kind: 'text', text: 'Please add the missing acceptance evidence.' }],
                  },
                },
              }, null, 2)} />
              <p className="mt-2 text-xs text-muted">POST to <Mono>{`${a2aOrigin}/a2a/${run.system_id}`}</Mono> with <Mono>content-type: application/json</Mono>. When <Mono>A2A_TOKEN</Mono> is set, add <Mono>authorization: Bearer …</Mono>.</p>
            </Card>
            <Card className="p-4">
              <h3 className="mb-2 text-sm font-semibold">Inspect the run as an A2A task</h3>
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-2/40 px-3 py-2">
                <Mono className="min-w-0 flex-1 truncate text-xs">{`${a2aOrigin}/a2a/${run.system_id}/tasks/${run.id}`}</Mono>
                <CopyButton text={() => `${a2aOrigin}/a2a/${run.system_id}/tasks/${run.id}`} label="Copy" />
              </div>
            </Card>
          </div>
        )}

        {tab === 'deliverables' && (
          <div className="space-y-5">
            <section>
              <h3 className="mb-2 text-sm font-semibold">Artifacts</h3>
              {artifacts.length === 0 ? <Card className="px-4 py-8 text-center text-sm text-muted">No artifacts published.</Card> : (
                <div className="grid gap-3 md:grid-cols-2">
                  {artifacts.map((a) => (
                    <Card key={a.id} className="p-4">
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-sm font-semibold">{a.name}</span>
                            <Badge tone="accent">{a.type}</Badge>
                            <Badge>v{a.version}</Badge>
                          </div>
                          <div className="mt-1 text-xs text-muted">{roles.get(a.member_id) ?? a.member_id} · {a.bytes != null ? `${fmtNum(a.bytes)} B` : 'size unknown'} · {timeAgo(a.created_at)}</div>
                          <div className="mt-0.5 truncate font-mono text-[11px] text-muted" title={a.content_hash}>{a.content_hash}</div>
                        </div>
                        <Button size="sm" variant="ghost" onClick={() => void downloadFromApi(teamApi.artifactUrl(id, a.id), a.name).catch((e) => toast.error(String(e)))}>
                          <Download className="size-3.5" />Get
                        </Button>
                      </div>
                    </Card>
                  ))}
                </div>
              )}
            </section>

            <section>
              <h3 className="mb-2 text-sm font-semibold">Handoffs <span className="font-normal text-muted">({handoffs.length})</span></h3>
              <Card className="overflow-hidden">
                {handoffs.length === 0 ? <div className="px-4 py-6 text-center text-sm text-muted">No handoffs yet.</div> : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="border-b border-border bg-surface-2/50"><tr><Th>From</Th><Th>To</Th><Th>Status</Th><Th>Summary</Th><Th>Artifacts</Th><Th>Decide</Th></tr></thead>
                      <tbody className="divide-y divide-border">
                        {handoffs.map((h) => {
                          const count = h.artifact_ids_json ? (JSON.parse(h.artifact_ids_json) as string[]).length : 0;
                          return (
                            <tr key={h.id}>
                              <Td>{roles.get(h.from_member) ?? h.from_member}</Td>
                              <Td>{roles.get(h.to_member) ?? h.to_member}</Td>
                              <Td><Badge tone={h.status === 'accepted' ? 'ok' : h.status === 'rejected' ? 'danger' : 'warn'}>{h.status}</Badge></Td>
                              <Td className="max-w-sm truncate text-muted" title={h.summary ?? ''}>{h.summary ?? '—'}</Td>
                              <Td className="text-muted">{count}</Td>
                              <Td>
                                <div className="flex gap-1">
                                  <Button size="sm" variant="ghost" onClick={() => void act('handoff-accept', () => teamApi.decideHandoff(id, h.id, 'accepted'), 'Handoff accepted')}>Accept</Button>
                                  <Button size="sm" variant="ghost" onClick={() => void act('handoff-reject', () => teamApi.decideHandoff(id, h.id, 'rejected', 'rejected from cockpit'), 'Handoff rejected')}>Reject</Button>
                                </div>
                              </Td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </section>

            <section>
              <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold"><GitBranch className="size-4" />Transcript</h3>
              <Card className="p-4">
                <div className="prose prose-sm max-w-none dark:prose-invert"><ReactMarkdown>{messages.data?.markdown ?? ''}</ReactMarkdown></div>
              </Card>
            </section>
          </div>
        )}

        {tab === 'timeline' && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-xs text-muted">
              <Badge tone={connected ? 'ok' : 'neutral'}>{connected ? 'streaming' : 'not streaming'}</Badge>
              <span>Append-only events, replayed in sequence order.</span>
            </div>
            <Card className="overflow-hidden">
              {events.length === 0 ? <div className="px-4 py-8 text-center text-sm text-muted">No events yet.</div> : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="border-b border-border bg-surface-2/50"><tr><Th>#</Th><Th>Time</Th><Th>Event</Th><Th>Member</Th><Th>Node</Th><Th>Payload</Th></tr></thead>
                    <tbody className="divide-y divide-border">
                      {events.map((e) => <EventRow key={e.seq} event={e} />)}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>
        )}

        {tab === 'snapshot' && (
          <div className="space-y-4">
            <Card className="p-4">
              <div className="mb-2 flex items-center justify-between">
                <div><h3 className="text-sm font-semibold">Run snapshot</h3><p className="text-xs text-muted">Immutable resolved configuration: agent versions, hashes, workflow and limits. Credentials are never included.</p></div>
                <CopyButton text={() => pretty(snapshot)} label="Copy JSON" />
              </div>
              <CodeBlock text={pretty(snapshot)} maxHeight="max-h-[32rem]" />
            </Card>
            <Card className="p-4">
              <h3 className="mb-2 text-sm font-semibold">Run record</h3>
              <CodeBlock text={pretty(run)} maxHeight="max-h-72" />
            </Card>
          </div>
        )}
      </div>
    </OpsPage>
  );
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-0.5 truncate text-sm">{children}</div>
    </div>
  );
}

function EventRow({ event }: { event: TeamEventRow }) {
  return (
    <tr className={cn(event.level === 'error' && 'bg-danger/5')}>
      <Td className="text-xs text-muted">{event.seq}</Td>
      <Td className="whitespace-nowrap text-xs text-muted">{fmtDate(event.ts)}</Td>
      <Td><Badge tone={levelTone(event.level)}>{event.kind}</Badge></Td>
      <Td className="text-xs">{event.memberId ?? '—'}</Td>
      <Td className="text-xs">{event.nodeId ?? '—'}</Td>
      <Td className="max-w-xl">
        <details>
          <summary className="cursor-pointer truncate font-mono text-[11px] text-muted">{JSON.stringify(event.payload).slice(0, 140)}</summary>
          <CodeBlock text={pretty(event.payload)} maxHeight="max-h-48" />
        </details>
      </Td>
    </tr>
  );
}
