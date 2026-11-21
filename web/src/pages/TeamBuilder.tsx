import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, GitBranch, Plus, Rocket, Save, ShieldCheck, Trash2 } from 'lucide-react';
import { api, errMsg } from '@/lib/api';
import { Badge, Button, Card, Field, Input, Select, Spinner, Tabs, Textarea, Toggle, cn, toast } from '@/components/ui';
import { ErrorNote, OpsPage } from '@/features/ops/components';
import { fmtDate } from '@/features/ops/lib';
import { MembersEditor, type AgentOption } from '@/features/teams/MembersEditor';
import { WorkflowDesigner } from '@/features/teams/WorkflowDesigner';
import { blankTeam, teamApi, type AgentSystemDefinition, type TeamDetail, type ValidationReport, type WorkflowDefinition } from '@/lib/teams';

type Tab = 'design' | 'workflows' | 'json';

export default function TeamBuilder() {
  const { id } = useParams();
  const isNew = !id;
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const detail = useQuery({ queryKey: ['team', id], queryFn: () => teamApi.get(id!), enabled: !isNew });
  const agents = useQuery({
    queryKey: ['agents-list'],
    queryFn: () => api<{ agents: AgentOption[] }>('/api/agents').then((r) => r.agents.filter((a) => (a.status ?? 'published') === 'published')),
  });

  const [def, setDef] = useState<AgentSystemDefinition>(() => blankTeam());
  const [baseline, setBaseline] = useState<string>('');
  const [tab, setTab] = useState<Tab>('design');
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [busy, setBusy] = useState<'save' | 'publish' | 'validate' | 'pin' | null>(null);
  const [jsonText, setJsonText] = useState('');

  // Load the stored draft once per team. After that the editor is the source of truth
  // (so background refetches never clobber typing).
  useEffect(() => {
    if (!detail.data) return;
    setDef(detail.data.definition);
    setBaseline(JSON.stringify(detail.data.definition));
    setReport(detail.data.validation);
  }, [detail.data?.id, detail.data?.updatedAt]);

  useEffect(() => { if (tab === 'json') setJsonText(JSON.stringify(def, null, 2)); }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = useMemo(() => JSON.stringify(def) !== baseline, [def, baseline]);
  const activeWorkflowId = sp.get('workflow') ?? def.orchestration.workflows[0]?.workflowId ?? '';
  const workflowIndex = Math.max(0, def.orchestration.workflows.findIndex((w) => w.workflowId === activeWorkflowId));
  const workflow = def.orchestration.workflows[workflowIndex];

  const patch = (next: Partial<AgentSystemDefinition>) => setDef((d) => ({ ...d, ...next }));
  const patchWorkflow = (next: Partial<WorkflowDefinition>) =>
    setDef((d) => {
      const workflows = d.orchestration.workflows.map((w, i) => (i === workflowIndex ? { ...w, ...next } : w));
      const defaultWorkflowId = next.workflowId ? (d.orchestration.defaultWorkflowId === d.orchestration.workflows[workflowIndex]?.workflowId ? next.workflowId : d.orchestration.defaultWorkflowId) : d.orchestration.defaultWorkflowId;
      return { ...d, orchestration: { ...d.orchestration, workflows, defaultWorkflowId } };
    });

  const pinAgent = async (index: number, agentId: string) => {
    const members = def.team.members.map((m, i) => {
      if (i !== index) return m;
      return agentId ? { ...m, agentRef: { agentId } } : { ...m, agentRef: { agentId: '' } };
    });
    patch({ team: { members } });
    if (!agentId) return;
    setBusy('pin');
    try {
      const row = await api<{ version: string; definition_hash?: string | null }>(`/api/agents/${encodeURIComponent(agentId)}`);
      setDef((d) => ({
        ...d,
        team: {
          members: d.team.members.map((m, i) => (i === index && m.agentRef.agentId === agentId
            ? { ...m, agentRef: { agentId, version: row.version, definitionHash: row.definition_hash ?? undefined } }
            : m)),
        },
      }));
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(null); }
  };

  const validate = async () => {
    setBusy('validate');
    try {
      const r = id ? await teamApi.validate(id, def) : await teamApi.validate('new', def);
      setReport(r);
      if (r.ok) toast.ok(`Valid — ${r.definitionHash}`);
      else toast.error('Validation failed');
    } catch (e) {
      setReport({ ok: false, errors: [errMsg(e)], warnings: [] });
      toast.error(errMsg(e));
    } finally { setBusy(null); }
  };

  const save = async (): Promise<TeamDetail | null> => {
    setBusy('save');
    try {
      const saved = isNew ? await teamApi.create(def) : await teamApi.update(id!, def);
      setDef(saved.definition);
      setBaseline(JSON.stringify(saved.definition));
      setReport(saved.validation);
      toast.ok(isNew ? 'Team created (draft)' : 'Draft saved');
      if (isNew) nav(`/teams/${encodeURIComponent(saved.id)}/edit`, { replace: true });
      return saved;
    } catch (e) {
      setReport({ ok: false, errors: [errMsg(e)], warnings: [] });
      toast.error(errMsg(e));
      return null;
    } finally { setBusy(null); }
  };

  const publish = async () => {
    const saved = await save();
    if (!saved) return;
    setBusy('publish');
    try {
      const published = await teamApi.publish(saved.id);
      setDef(published.definition);
      setBaseline(JSON.stringify(published.definition));
      setReport(published.validation);
      toast.ok(`Published ${published.id}@${published.currentVersion}`);
    } catch (e) {
      setReport({ ok: false, errors: [errMsg(e)], warnings: [] });
      toast.error(errMsg(e));
    } finally { setBusy(null); }
  };

  const applyJson = () => {
    try {
      const parsed = JSON.parse(jsonText) as AgentSystemDefinition;
      setDef(parsed);
      setReport(null);
      toast.ok('JSON applied to the editor');
    } catch (e) { toast.error(`Invalid JSON: ${errMsg(e)}`); }
  };

  const addWorkflow = () => {
    const n = def.orchestration.workflows.length + 1;
    const wf: WorkflowDefinition = {
      workflowId: `workflow-${n}`, name: `Workflow ${n}`, mode: 'sequential', version: def.metadata.version,
      entryNodeId: 'start', limits: { maxNodeRuns: 12, maxIterations: 6, maxAttempts: 2 },
      nodes: [{ nodeId: 'start', type: 'agent-task', memberId: def.team.members[0]?.memberId }, { nodeId: 'done', type: 'terminal' }],
      edges: [{ from: 'start', to: 'done' }],
    };
    patch({ orchestration: { ...def.orchestration, workflows: [...def.orchestration.workflows, wf] } });
    setSp({ workflow: wf.workflowId });
  };

  const removeWorkflow = () => {
    const remaining = def.orchestration.workflows.filter((_, i) => i !== workflowIndex);
    const defaultWorkflowId = remaining.some((w) => w.workflowId === def.orchestration.defaultWorkflowId) ? def.orchestration.defaultWorkflowId : remaining[0]?.workflowId ?? '';
    patch({ orchestration: { ...def.orchestration, workflows: remaining, defaultWorkflowId } });
    setSp({ workflow: remaining[0]?.workflowId ?? '' });
  };

  const title = isNew ? 'New team' : (detail.data?.name ?? 'Team');
  const actions = (
    <div className="flex items-center gap-2">
      <Button variant="ghost" onClick={() => nav('/teams')}><ArrowLeft className="size-4" />Teams</Button>
      <Button onClick={() => void validate()} loading={busy === 'validate'}><ShieldCheck className="size-4" />Validate</Button>
      <Button onClick={() => void save()} loading={busy === 'save'} disabled={!dirty && !isNew}><Save className="size-4" />{isNew ? 'Create draft' : 'Save draft'}</Button>
      <Button variant="primary" onClick={() => void publish()} loading={busy === 'publish'}><Rocket className="size-4" />Publish</Button>
    </div>
  );

  if (!isNew && detail.isLoading) return <OpsPage title="Team"><div className="flex justify-center py-24"><Spinner className="size-6" /></div></OpsPage>;
  if (!isNew && (detail.error || !detail.data)) {
    return <OpsPage title="Team" actions={<Button variant="ghost" onClick={() => nav('/teams')}><ArrowLeft className="size-4" />Teams</Button>}>
      <ErrorNote error={detail.error ?? 'Team not found'} />
    </OpsPage>;
  }

  return (
    <OpsPage title={title} description={isNew ? 'Define roles, workflows and delegation — then publish an immutable version.' : `${def.metadata.id} · ${detail.data?.currentVersion ? `published v${detail.data.currentVersion}` : 'not published'}`} actions={actions}>
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-2">
          <Tabs value={tab} onChange={setTab} items={[{ id: 'design', label: 'Team' }, { id: 'workflows', label: 'Workflows' }, { id: 'json', label: 'JSON' }]} />
          {dirty ? <Badge tone="warn">unsaved changes</Badge> : !isNew ? <Badge tone="ok">saved</Badge> : null}
          {report && <Badge tone={report.ok ? 'ok' : 'danger'}>{report.ok ? 'valid' : `${report.errors.length} error${report.errors.length === 1 ? '' : 's'}`}</Badge>}
          {busy === 'pin' && <Spinner className="size-4" />}
        </div>

        {report && !report.ok && (
          <div className="rounded-lg border border-danger/30 bg-danger/10 p-3">
            <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-danger">Validation</div>
            <ul className="list-disc space-y-0.5 pl-5 text-sm text-danger">{report.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
          </div>
        )}
        {report?.warnings?.length ? (
          <div className="rounded-lg border border-warn/30 bg-warn/10 p-3 text-sm text-warn">
            <div className="mb-1 text-xs font-semibold uppercase tracking-wider">Warnings</div>
            <ul className="list-disc space-y-0.5 pl-5">{report.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
          </div>
        ) : null}

        {tab === 'design' && (
          <div className="space-y-5">
            <Card className="p-4">
              <h3 className="mb-3 text-sm font-semibold">Identity</h3>
              <div className="grid gap-3 md:grid-cols-2">
                <Field label="Team id" hint="Stable id; runs and versions are keyed by it."><Input value={def.metadata.id} disabled={!isNew} onChange={(e) => patch({ metadata: { ...def.metadata, id: e.target.value } })} placeholder="software-delivery-team" /></Field>
                <Field label="Name"><Input value={def.metadata.name} onChange={(e) => patch({ metadata: { ...def.metadata, name: e.target.value } })} placeholder="Autonomous Software Delivery Team" /></Field>
                <Field label="Version"><Input value={def.metadata.version} onChange={(e) => patch({ metadata: { ...def.metadata, version: e.target.value } })} placeholder="1.0.0" /></Field>
                <Field label="Tags" hint="Comma separated."><Input value={(def.metadata.tags ?? []).join(', ')} onChange={(e) => patch({ metadata: { ...def.metadata, tags: e.target.value.trim() ? e.target.value.split(',').map((s) => s.trim()).filter(Boolean) : undefined } })} placeholder="delivery, agile" /></Field>
                <Field label="Description" className="md:col-span-2"><Textarea rows={2} value={def.metadata.description ?? ''} onChange={(e) => patch({ metadata: { ...def.metadata, description: e.target.value } })} placeholder="An Agile team capable of delivering software end to end." /></Field>
              </div>
            </Card>

            <Card className="p-4">
              <h3 className="mb-3 text-sm font-semibold">Communication</h3>
              <div className="grid gap-4 md:grid-cols-2">
                <Toggle checked={def.orchestration.communication?.enabled !== false} onChange={(v) => patch({ orchestration: { ...def.orchestration, communication: { ...def.orchestration.communication, enabled: v } } })}
                  label="Team communication" description="Persist agent-to-agent messages and deliver them on the recipient's next turn." />
                <Toggle checked={def.orchestration.communication?.allowPeerToPeer !== false} onChange={(v) => patch({ orchestration: { ...def.orchestration, communication: { ...def.orchestration.communication, allowPeerToPeer: v } } })}
                  label="Peer-to-peer messaging" description="Off: only the orchestrator and managers may address members." />
                <Field label="Max message rounds" hint="Delivery rounds before the engine declares the flow stalled.">
                  <Input type="number" min={1} max={20} value={def.orchestration.communication?.maxRounds ?? 3}
                    onChange={(e) => patch({ orchestration: { ...def.orchestration, communication: { ...def.orchestration.communication, maxRounds: Number(e.target.value) } } })} />
                </Field>
                <Field label="Context policy" hint="Threads and artifacts, or artifacts only (no conversation transcript).">
                  <Select value={def.orchestration.communication?.contextPolicy ?? 'thread-and-artifacts'}
                    onChange={(e) => patch({ orchestration: { ...def.orchestration, communication: { ...def.orchestration.communication, contextPolicy: e.target.value as 'thread-and-artifacts' | 'artifacts-only' } } })}>
                    <option value="thread-and-artifacts">thread-and-artifacts</option>
                    <option value="artifacts-only">artifacts-only</option>
                  </Select>
                </Field>
                <Field label="Chat verbosity" hint="Progress is always on the board; this only controls how much chat is allowed.">
                  <Select value={def.orchestration.communication?.verbosity ?? 'concise'}
                    onChange={(e) => patch({ orchestration: { ...def.orchestration, communication: { ...def.orchestration.communication, verbosity: e.target.value as 'minimal' | 'concise' | 'normal' } } })}>
                    <option value="minimal">minimal — handoffs, blockers, decisions</option>
                    <option value="concise">concise — also short reviews</option>
                    <option value="normal">normal — legacy</option>
                  </Select>
                </Field>
                <Field label="Max messages per turn" hint="Hard cap across tool calls and output.replies.">
                  <Input type="number" min={0} max={20} value={def.orchestration.communication?.maxMessagesPerTurn ?? 2}
                    onChange={(e) => patch({ orchestration: { ...def.orchestration, communication: { ...def.orchestration.communication, maxMessagesPerTurn: Number(e.target.value) } } })} />
                </Field>
                <Field label="Max message characters" hint="Long messages are truncated; status belongs on the progress board.">
                  <Input type="number" min={120} max={20000} value={def.orchestration.communication?.maxBodyChars ?? 600}
                    onChange={(e) => patch({ orchestration: { ...def.orchestration, communication: { ...def.orchestration.communication, maxBodyChars: Number(e.target.value) } } })} />
                </Field>
              </div>
            </Card>

            <section>
              <div className="mb-2 flex items-center justify-between">
                <div><h3 className="text-sm font-semibold">Members</h3><p className="text-xs text-muted">Each member references an existing agent by version and hash. Editing the team never edits the agent.</p></div>
              </div>
              <MembersEditor members={def.team.members} agents={agents.data ?? []} onChange={(members) => patch({ team: { members } })} onPickAgent={(i, agentId) => void pinAgent(i, agentId)} />
            </section>

            {!isNew && detail.data && (
              <Card className="overflow-hidden">
                <div className="flex items-center justify-between border-b border-border px-4 py-3">
                  <h3 className="text-sm font-semibold">Published versions</h3>
                  {detail.data.hasDraftChanges && <Badge tone="warn">draft differs from v{detail.data.currentVersion}</Badge>}
                </div>
                <table className="w-full text-sm">
                  <thead className="border-b border-border bg-surface-2/50"><tr><th className="px-4 py-2 text-left text-[11px] uppercase text-muted">Version</th><th className="px-4 py-2 text-left text-[11px] uppercase text-muted">Hash</th><th className="px-4 py-2 text-left text-[11px] uppercase text-muted">Published</th></tr></thead>
                  <tbody className="divide-y divide-border">
                    {detail.data.versions.map((v) => (
                      <tr key={v.version}>
                        <td className="px-4 py-2">v{v.version} {v.version === detail.data?.currentVersion && <Badge tone="ok">current</Badge>}</td>
                        <td className="px-4 py-2 font-mono text-xs text-muted">{v.definition_hash.slice(0, 24)}…</td>
                        <td className="px-4 py-2 text-xs text-muted">{fmtDate(v.published_at)}</td>
                      </tr>
                    ))}
                    {detail.data.versions.length === 0 && <tr><td colSpan={3} className="px-4 py-6 text-center text-sm text-muted">Never published. Runs require a published version.</td></tr>}
                  </tbody>
                </table>
              </Card>
            )}
          </div>
        )}

        {tab === 'workflows' && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              {def.orchestration.workflows.map((w) => (
                <button key={w.workflowId} onClick={() => setSp({ workflow: w.workflowId })}
                  className={cn('flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs', w.workflowId === workflow?.workflowId ? 'border-accent bg-accent/10 text-fg' : 'border-border text-muted hover:text-fg')}>
                  <GitBranch className="size-3" />{w.name}
                  {w.workflowId === def.orchestration.defaultWorkflowId && <Badge tone="ok">default</Badge>}
                </button>
              ))}
              <Button size="sm" onClick={addWorkflow}><Plus className="size-3.5" />Add workflow</Button>
              {def.orchestration.workflows.length > 1 && <Button size="sm" variant="ghost" onClick={removeWorkflow}><Trash2 className="size-3.5" />Remove</Button>}
            </div>

            <div className="flex flex-wrap items-end gap-3">
              <Field label="Default workflow" hint="Used when a run does not name one.">
                <Select value={def.orchestration.defaultWorkflowId}
                  onChange={(e) => patch({ orchestration: { ...def.orchestration, defaultWorkflowId: e.target.value } })}>
                  {def.orchestration.workflows.map((w) => <option key={w.workflowId} value={w.workflowId}>{w.name}</option>)}
                </Select>
              </Field>
            </div>

            {workflow ? <WorkflowDesigner workflow={workflow} members={def.team.members} onChange={patchWorkflow} /> : (
              <Card className="px-4 py-6 text-center text-sm text-muted">No workflow selected.</Card>
            )}
          </div>
        )}

        {tab === 'json' && (
          <Card className="p-4">
            <div className="mb-2 flex items-center justify-between">
              <div><h3 className="text-sm font-semibold">Definition JSON</h3><p className="text-xs text-muted">Edit the full agent-system-definition. Applying replaces the editor state; Validate checks it against the schema and agent pins.</p></div>
              <Button onClick={applyJson}>Apply JSON</Button>
            </div>
            <Textarea rows={28} spellCheck={false} className="font-mono text-xs" value={jsonText} onChange={(e) => setJsonText(e.target.value)} aria-label="Team definition JSON" />
          </Card>
        )}
      </div>
    </OpsPage>
  );
}
