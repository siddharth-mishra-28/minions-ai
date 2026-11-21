import { ArrowRight, GitBranch, Plus, Trash2 } from 'lucide-react';
import { Badge, Button, Card, Field, IconButton, Input, Select, Textarea, Toggle } from '@/components/ui';
import type { ConditionOperator, TeamMember, WorkflowDefinition, WorkflowEdge, WorkflowNode, WorkflowNodeType } from '@/lib/teams';

const NODE_TYPES: WorkflowNodeType[] = ['agent-task', 'manager', 'join', 'human-approval', 'terminal'];
const OPERATORS: ConditionOperator[] = ['equals', 'not-equals', 'in', 'contains', 'exists', 'gt', 'lt', 'gte', 'lte', 'matches'];

const showValue = (v: unknown): string => (v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v));
const parseValue = (text: string): unknown => {
  if (!text.trim()) return undefined;
  try { return JSON.parse(text) as unknown; } catch { return text; }
};

export function WorkflowDesigner({ workflow, members, onChange }: {
  workflow: WorkflowDefinition;
  members: TeamMember[];
  onChange: (patch: Partial<WorkflowDefinition>) => void;
}) {
  const memberIds = members.map((m) => m.memberId).filter(Boolean);
  const nodeIds = workflow.nodes.map((n) => n.nodeId).filter(Boolean);

  const patchNode = (index: number, next: Partial<WorkflowNode>) =>
    onChange({ nodes: workflow.nodes.map((n, i) => (i === index ? { ...n, ...next } : n)) });

  const removeNode = (index: number) => {
    const nodeId = workflow.nodes[index]?.nodeId;
    onChange({
      nodes: workflow.nodes.filter((_, i) => i !== index),
      edges: workflow.edges.filter((e) => e.from !== nodeId && e.to !== nodeId),
    });
  };

  const addNode = () => {
    const nodeId = `step-${workflow.nodes.length}`;
    onChange({
      nodes: [...workflow.nodes, { nodeId, type: 'agent-task', memberId: memberIds[0] }],
      // Keep the graph connected: the new node becomes the last node's successor.
      edges: workflow.nodes.length ? [...workflow.edges, { from: workflow.nodes[workflow.nodes.length - 1].nodeId, to: nodeId }] : [],
      entryNodeId: workflow.entryNodeId || nodeId,
    });
  };

  const patchEdge = (index: number, next: Partial<WorkflowEdge>) =>
    onChange({ edges: workflow.edges.map((e, i) => (i === index ? { ...e, ...next } : e)) });

  const setLimit = (key: keyof NonNullable<WorkflowDefinition['limits']>, value: string) => {
    const n = Number(value);
    onChange({ limits: { ...(workflow.limits ?? {}), [key]: Number.isFinite(n) ? n : undefined } });
  };

  return (
    <div className="space-y-5">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Field label="Workflow id"><Input value={workflow.workflowId} onChange={(e) => onChange({ workflowId: e.target.value })} placeholder="agile-delivery" /></Field>
        <Field label="Name"><Input value={workflow.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="Sequential Agile Delivery" /></Field>
        <Field label="Mode" hint="Sequential, parallel fan-out, manager-led or hybrid.">
          <Select value={workflow.mode} onChange={(e) => onChange({ mode: e.target.value as WorkflowDefinition['mode'] })}>
            {['sequential', 'parallel', 'hierarchical', 'hybrid'].map((m) => <option key={m} value={m}>{m}</option>)}
          </Select>
        </Field>
        <Field label="Entry node" hint="Where execution starts.">
          <Select value={workflow.entryNodeId} onChange={(e) => onChange({ entryNodeId: e.target.value })}>
            {nodeIds.map((id) => <option key={id} value={id}>{id}</option>)}
          </Select>
        </Field>
      </div>

      <Card className="p-4">
        <h4 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">Execution limits</h4>
        <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-5">
          <Field label="Max node runs"><Input type="number" min={1} value={workflow.limits?.maxNodeRuns ?? ''} onChange={(e) => setLimit('maxNodeRuns', e.target.value)} /></Field>
          <Field label="Max iterations"><Input type="number" min={1} value={workflow.limits?.maxIterations ?? ''} onChange={(e) => setLimit('maxIterations', e.target.value)} /></Field>
          <Field label="Max attempts"><Input type="number" min={1} value={workflow.limits?.maxAttempts ?? ''} onChange={(e) => setLimit('maxAttempts', e.target.value)} /></Field>
          <Field label="Max concurrent tasks"><Input type="number" min={1} value={workflow.limits?.maxConcurrentTasks ?? ''} onChange={(e) => setLimit('maxConcurrentTasks', e.target.value)} /></Field>
          <Field label="Max duration (ms)"><Input type="number" min={1000} value={workflow.limits?.maxDurationMs ?? ''} onChange={(e) => setLimit('maxDurationMs', e.target.value)} /></Field>
        </div>
      </Card>

      {workflow.mode === 'hierarchical' && (
        <Card className="p-4">
          <h4 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted"><GitBranch className="size-3.5" />Manager policy</h4>
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Manager member">
              <Select value={workflow.manager?.memberId ?? ''} onChange={(e) => onChange({ manager: { ...(workflow.manager ?? { maxDelegationDepth: 2, maxParallelTasks: 2 }), memberId: e.target.value } })}>
                <option value="">Select…</option>
                {memberIds.map((id) => <option key={id} value={id}>{id}</option>)}
              </Select>
            </Field>
            <Field label="Max delegation depth"><Input type="number" min={1} max={6} value={workflow.manager?.maxDelegationDepth ?? 2}
              onChange={(e) => onChange({ manager: { ...(workflow.manager ?? { memberId: memberIds[0] ?? '' }), maxDelegationDepth: Number(e.target.value) } })} /></Field>
            <Field label="Max parallel tasks"><Input type="number" min={1} max={10} value={workflow.manager?.maxParallelTasks ?? 2}
              onChange={(e) => onChange({ manager: { ...(workflow.manager ?? { memberId: memberIds[0] ?? '' }), maxParallelTasks: Number(e.target.value) } })} /></Field>
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <Toggle checked={!!workflow.manager?.allowDynamicTaskCreation} onChange={(v) => onChange({ manager: { ...(workflow.manager ?? { memberId: memberIds[0] ?? '' }), allowDynamicTaskCreation: v } })}
              label="Allow dynamic task creation" description="The manager may add tasks (and run-scoped specialists) at runtime." />
            <Toggle checked={workflow.manager?.requireCompletionReview !== false} onChange={(v) => onChange({ manager: { ...(workflow.manager ?? { memberId: memberIds[0] ?? '' }), requireCompletionReview: v } })}
              label="Require completion review" description="The manager must review results before the run can complete." />
          </div>
        </Card>
      )}

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted">Nodes <span className="normal-case tracking-normal">({workflow.nodes.length})</span></h4>
          <Button size="sm" onClick={addNode}><Plus className="size-3.5" />Add node</Button>
        </div>
        <div className="space-y-2">
          {workflow.nodes.map((node, i) => (
            <Card key={i} className="p-3">
              <div className="flex flex-wrap items-end gap-2">
                <div className="w-36"><Field label="Node id"><Input value={node.nodeId} onChange={(e) => patchNode(i, { nodeId: e.target.value })} /></Field></div>
                <div className="w-40"><Field label="Type">
                  <Select value={node.type} onChange={(e) => patchNode(i, { type: e.target.value as WorkflowNodeType, memberId: e.target.value === 'terminal' ? undefined : node.memberId })}>
                    {NODE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </Select>
                </Field></div>
                <div className="w-44"><Field label="Member">
                  <Select value={node.memberId ?? ''} disabled={node.type === 'terminal' || node.type === 'join'} onChange={(e) => patchNode(i, { memberId: e.target.value || undefined })}>
                    <option value="">{node.type === 'terminal' ? '—' : 'Select…'}</option>
                    {memberIds.map((id) => <option key={id} value={id}>{id}</option>)}
                  </Select>
                </Field></div>
                <div className="min-w-48 flex-1"><Field label="Label (optional)"><Input value={node.label ?? ''} onChange={(e) => patchNode(i, { label: e.target.value || undefined })} placeholder="Implementation" /></Field></div>
                <div className="min-w-56 flex-1"><Field label="Output contract" hint="Comma-separated artifact types this node must publish.">
                  <Input value={(node.outputContract?.artifactTypes ?? []).join(', ')}
                    onChange={(e) => patchNode(i, { outputContract: e.target.value.trim() ? { artifactTypes: e.target.value.split(',').map((s) => s.trim()).filter(Boolean), required: node.outputContract?.required ?? true } : undefined })} />
                </Field></div>
                <IconButton label="Remove node" aria-label={`Remove ${node.nodeId}`} onClick={() => removeNode(i)}><Trash2 className="size-4" /></IconButton>
              </div>
              {(node.type === 'human-approval' || node.task) && (
                <div className="mt-2 grid gap-2 md:grid-cols-2">
                  {node.type === 'human-approval' && (
                    <Field label="Approval prompt"><Input value={node.approval?.prompt ?? ''} onChange={(e) => patchNode(i, { approval: { ...node.approval, prompt: e.target.value || undefined } })} placeholder="Ship it?" /></Field>
                  )}
                  <Field label="Node task override"><Textarea rows={2} value={node.task ?? ''} onChange={(e) => patchNode(i, { task: e.target.value || undefined })} placeholder="Extra instruction appended to the member brief." /></Field>
                </div>
              )}
            </Card>
          ))}
        </div>
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted">Transitions <span className="normal-case tracking-normal">({workflow.edges.length})</span></h4>
          <Button size="sm" disabled={workflow.nodes.length < 2}
            onClick={() => onChange({ edges: [...workflow.edges, { from: nodeIds[0], to: nodeIds[1] }] })}><Plus className="size-3.5" />Add transition</Button>
        </div>
        <Card className="divide-y divide-border">
          {workflow.edges.length === 0 && <div className="px-4 py-6 text-center text-sm text-muted">No transitions yet.</div>}
          {workflow.edges.map((edge, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2 p-3">
              <div className="w-36"><Field label="From">
                <Select value={edge.from} onChange={(e) => patchEdge(i, { from: e.target.value })}>{nodeIds.map((id) => <option key={id} value={id}>{id}</option>)}</Select>
              </Field></div>
              <ArrowRight className="mb-2 size-4 shrink-0 text-muted" />
              <div className="w-36"><Field label="To">
                <Select value={edge.to} onChange={(e) => patchEdge(i, { to: e.target.value })}>{nodeIds.map((id) => <option key={id} value={id}>{id}</option>)}</Select>
              </Field></div>
              <div className="w-40"><Field label="Condition" hint="Empty = unconditional.">
                <Input value={edge.when?.path ?? ''} onChange={(e) => patchEdge(i, { when: e.target.value ? { path: e.target.value, operator: edge.when?.operator ?? 'equals', value: edge.when?.value } : undefined })} placeholder="output.status" />
              </Field></div>
              <div className="w-32"><Field label="Operator">
                <Select value={edge.when?.operator ?? 'equals'} disabled={!edge.when} onChange={(e) => patchEdge(i, { when: { path: edge.when?.path ?? 'output.status', operator: e.target.value as ConditionOperator, value: edge.when?.value } })}>
                  {OPERATORS.map((op) => <option key={op} value={op}>{op}</option>)}
                </Select>
              </Field></div>
              <div className="w-36"><Field label="Value">
                <Input value={showValue(edge.when?.value)} disabled={!edge.when || edge.when.operator === 'exists'} onChange={(e) => patchEdge(i, { when: { path: edge.when?.path ?? 'output.status', operator: edge.when?.operator ?? 'equals', value: parseValue(e.target.value) } })} placeholder="passed" />
              </Field></div>
              <div className="min-w-32 flex-1"><Field label="Label (optional)"><Input value={edge.label ?? ''} onChange={(e) => patchEdge(i, { label: e.target.value || undefined })} placeholder="rework" /></Field></div>
              <IconButton label="Remove transition" aria-label="Remove transition" onClick={() => onChange({ edges: workflow.edges.filter((_, x) => x !== i) })}><Trash2 className="size-4" /></IconButton>
            </div>
          ))}
        </Card>
        {workflow.mode === 'sequential' && <p className="mt-2 text-xs text-muted"><Badge tone="accent">tip</Badge> Sequential workflows run nodes in edge order; give each node a single outgoing transition, plus conditionals for review loops.</p>}
      </section>
    </div>
  );
}
