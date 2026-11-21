import { useMemo } from 'react';
import { Link2, Plus, Trash2, UserRound } from 'lucide-react';
import { Badge, Button, Card, Field, IconButton, Input, Select, Textarea, Toggle } from '@/components/ui';
import type { TeamMember } from '@/lib/teams';

export interface AgentOption { id: string; name: string; version: string; definition_hash?: string | null; status?: string }

export function MembersEditor({ members, agents, onChange, onPickAgent }: {
  members: TeamMember[];
  agents: AgentOption[];
  onChange: (members: TeamMember[]) => void;
  onPickAgent: (index: number, agentId: string) => void;
}) {
  const ids = useMemo(() => members.map((m) => m.memberId).filter(Boolean), [members]);
  const patch = (index: number, next: Partial<TeamMember>) =>
    onChange(members.map((m, i) => (i === index ? { ...m, ...next } : m)));

  const add = () => {
    const n = members.length + 1;
    onChange([...members, { memberId: `member-${n}`, role: 'Specialist', agentRef: { agentId: '' } }]);
  };

  return (
    <div className="space-y-3">
      {members.length === 0 && (
        <Card className="px-4 py-6 text-center text-sm text-muted">
          No members yet. Add independently registered agents and give them a role in this team.
        </Card>
      )}
      {members.map((m, i) => {
        const agent = agents.find((a) => a.id === m.agentRef.agentId);
        return (
          <Card key={i} className="p-4">
            <div className="mb-3 flex items-center gap-2">
              <span className="flex size-7 items-center justify-center rounded-lg bg-surface-2 text-muted"><UserRound className="size-4" /></span>
              <span className="text-sm font-semibold">{m.role || m.memberId || `Member ${i + 1}`}</span>
              {m.agentRef.definitionHash ? <Badge tone="ok"><Link2 className="size-3" />pinned</Badge> : <Badge tone="warn">unpinned</Badge>}
              <span className="ml-auto" />
              <IconButton label="Remove member" aria-label={`Remove ${m.memberId}`} onClick={() => onChange(members.filter((_, x) => x !== i))}><Trash2 className="size-4" /></IconButton>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Member id" hint="Stable id used by workflow nodes and delegation.">
                <Input value={m.memberId} onChange={(e) => patch(i, { memberId: e.target.value })} placeholder="qa-engineer" aria-label={`Member id ${i}`} />
              </Field>
              <Field label="Role" hint="Human-facing title shown in chat and the execution tree.">
                <Input value={m.role} onChange={(e) => patch(i, { role: e.target.value })} placeholder="QA Engineer" aria-label={`Role ${i}`} />
              </Field>
              <Field label="Agent definition" hint={m.agentRef.agentId ? `Pinned to ${agent?.version ?? m.agentRef.version ?? 'version'}; provider, tools and persona stay owned by the agent.` : 'Pick a registered agent.'}>
                <Select value={m.agentRef.agentId} onChange={(e) => onPickAgent(i, e.target.value)} aria-label={`Agent ${i}`}>
                  <option value="">Select an agent…</option>
                  {agents.map((a) => <option key={a.id} value={a.id}>{a.name} · v{a.version}</option>)}
                </Select>
              </Field>
              <Field label="Reports to" hint="Optional reporting line (used by hierarchical teams).">
                <Select value={m.reportsTo ?? ''} onChange={(e) => patch(i, { reportsTo: e.target.value || undefined })} aria-label={`Reports to ${i}`}>
                  <option value="">No manager</option>
                  {ids.filter((id) => id && id !== m.memberId).map((id) => <option key={id} value={id}>{id}</option>)}
                </Select>
              </Field>
            </div>

            <div className="mt-3 space-y-3 border-t border-border pt-3">
              <div className="flex flex-wrap gap-4">
                {([['canReview', 'Can review'], ['canApprove', 'Can approve'], ['canDelegate', 'Can delegate']] as const).map(([key, label]) => (
                  <label key={key} className="flex items-center gap-1.5 text-xs text-muted">
                    <input type="checkbox" checked={!!m.capabilities?.[key]}
                      onChange={(e) => patch(i, { capabilities: { ...m.capabilities, [key]: e.target.checked } })} />
                    {label}
                  </label>
                ))}
              </div>

              <Toggle checked={!!m.delegation?.enabled} onChange={(v) => patch(i, { delegation: v ? { enabled: true, maxDepth: 2, maxConcurrentDelegates: 2 } : undefined })}
                label="Delegation policy" description="Allow this member to hand tasks to other members (managers usually need this)." />

              {m.delegation?.enabled && (
                <div className="grid gap-3 md:grid-cols-2">
                  <Field label="Max depth"><Input type="number" min={1} max={6} value={m.delegation.maxDepth ?? 2}
                    onChange={(e) => patch(i, { delegation: { ...m.delegation, maxDepth: Number(e.target.value) } })} /></Field>
                  <Field label="Max concurrent delegates"><Input type="number" min={1} max={10} value={m.delegation.maxConcurrentDelegates ?? 2}
                    onChange={(e) => patch(i, { delegation: { ...m.delegation, maxConcurrentDelegates: Number(e.target.value) } })} /></Field>
                  <div className="md:col-span-2">
                    <div className="mb-1 text-xs font-medium text-muted">Allowed delegates</div>
                    <div className="flex flex-wrap gap-2">
                      {ids.filter((id) => id !== m.memberId).map((id) => {
                        const allowed = m.delegation?.allowedMemberIds ?? [];
                        const on = allowed.includes(id);
                        return (
                          <label key={id} className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs">
                            <input type="checkbox" checked={on} onChange={() => patch(i, {
                              delegation: { ...m.delegation, allowedMemberIds: on ? allowed.filter((x) => x !== id) : [...allowed, id] },
                            })} />
                            {id}
                          </label>
                        );
                      })}
                      {ids.length <= 1 && <span className="text-xs text-muted">Add more members first.</span>}
                    </div>
                  </div>
                </div>
              )}

              <Field label="Run-scoped instructions" hint="Appended to this member's task brief on every turn.">
                <Textarea rows={2} value={m.instructions ?? ''} onChange={(e) => patch(i, { instructions: e.target.value || undefined })} placeholder="Focus on security and rollback safety." />
              </Field>
            </div>
          </Card>
        );
      })}
      <Button onClick={add}><Plus className="size-4" />Add member</Button>
    </div>
  );
}
