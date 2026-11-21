import { api } from './api';

/** Mirrors src/systems/types.ts — the shapes the team API returns. */
export type WorkflowMode = 'sequential' | 'parallel' | 'hierarchical' | 'hybrid';
export type WorkflowNodeType = 'agent-task' | 'manager' | 'join' | 'human-approval' | 'terminal';
export type NodeType = WorkflowNodeType;
export type ConditionOperator = 'equals' | 'not-equals' | 'in' | 'contains' | 'exists' | 'gt' | 'lt' | 'gte' | 'lte' | 'matches';

export interface AgentRef { agentId: string; version?: string; definitionHash?: string }
export interface DelegationPolicy { enabled?: boolean; allowedMemberIds?: string[]; maxDepth?: number; maxConcurrentDelegates?: number }
export interface TeamMember {
  memberId: string; role: string; reportsTo?: string; agentRef: AgentRef;
  delegation?: DelegationPolicy; capabilities?: { canReview?: boolean; canApprove?: boolean; canDelegate?: boolean }; instructions?: string;
}
export interface WorkflowNode {
  nodeId: string; type: NodeType; memberId?: string; label?: string; task?: string;
  outputContract?: { artifactTypes?: string[]; required?: boolean };
  approval?: { prompt?: string; role?: string };
  join?: { mode?: 'all' | 'any' };
}
export interface EdgeCondition { path: string; operator: ConditionOperator; value?: unknown }
export interface WorkflowEdge { from: string; to: string; when?: EdgeCondition; label?: string }
export interface ManagerPolicy { memberId: string; maxDelegationDepth?: number; maxParallelTasks?: number; allowDynamicTaskCreation?: boolean; requireCompletionReview?: boolean }
export interface WorkflowLimits {
  maxDurationMs?: number; maxNodeRuns?: number; maxIterations?: number;
  maxConcurrentTasks?: number; maxAttempts?: number; backoffMs?: number; retryBackoffMultiplier?: number;
}
export interface WorkflowDefinition {
  workflowId: string; name: string; mode: WorkflowMode; version?: string; entryNodeId: string;
  nodes: WorkflowNode[]; edges: WorkflowEdge[]; manager?: ManagerPolicy; limits?: WorkflowLimits;
}
export interface CommunicationPolicy {
  enabled?: boolean; allowPeerToPeer?: boolean; persistMessages?: boolean; maxRounds?: number;
  contextPolicy?: 'thread-and-artifacts' | 'artifacts-only';
  verbosity?: 'minimal' | 'concise' | 'normal';
  maxMessagesPerTurn?: number;
  maxBodyChars?: number;
}
export interface AgentSystemDefinition {
  schemaVersion: '1.0'; kind: 'agent-system';
  metadata: { id: string; name: string; version: string; description?: string; tags?: string[] };
  team: { members: TeamMember[] };
  orchestration: { defaultWorkflowId: string; communication?: CommunicationPolicy; workflows: WorkflowDefinition[] };
}

export interface TeamSummary {
  id: string; name: string; description: string | null; status: string; currentVersion: string | null;
  updatedAt: string; createdAt: string; runCount: number; lastRunAt: string | null;
  members: { memberId: string; role: string; agentId: string; pinned: boolean }[];
  workflows: { workflowId: string; name: string; mode: string }[];
}

export interface ValidationReport { ok: boolean; errors: string[]; warnings: string[]; definitionHash?: string }
export interface TeamDetail extends TeamSummary {
  definition: AgentSystemDefinition; definitionJson: string; definitionHash: string; hasDraftChanges: boolean;
  validation: ValidationReport;
  versions: { version: string; definition_hash: string; published_at: string }[];
  workflowVersions: { workflow_id: string; version: string; definition_hash: string; created_at: string }[];
}

export type TeamRunStatus = 'queued' | 'running' | 'awaiting-approval' | 'interrupted' | 'done' | 'failed' | 'stopped';

export interface TeamRunRow {
  id: string; system_id: string; system_name: string; system_version: string; workflow_id: string; workflow_version: string;
  mode: string; status: TeamRunStatus | string; task: string; workspace: string;
  started_at: string | null; finished_at: string | null; error: string | null; created_at: string;
}
export interface NodeRunRow {
  id: string; system_run_id: string; node_id: string; member_id: string | null; attempt: number; iteration: number;
  status: string; run_id: string | null; task: string | null; output_json: string | null; error: string | null;
  started_at: string; finished_at: string | null;
}
export interface SessionRow { member_id: string; copilot_session_id: string; agent_id: string | null; workspace: string | null; created_at: string; last_used_at: string }
export type TeamMessageType = 'message' | 'task-request' | 'clarification' | 'proposal' | 'review-request' | 'review-response' | 'decision' | 'handoff' | 'status-update' | 'escalation';
export interface TeamMessageRow {
  id: string; system_run_id: string; thread_id: string | null; from_member: string; to_members: string[];
  type: TeamMessageType; body: string; artifact_ids_json: string | null; reply_to: string | null;
  task_id: string | null; node_id: string | null; created_at: string; delivered_at: string | null;
  message_id?: string | null; context_id?: string | null; protocol?: string | null;
  parts_json?: string | null; progress_json?: string | null; updated_at?: string | null;
}
export interface MemberProgressRow {
  system_run_id: string; member_id: string; status: string; percent: number;
  phase: string | null; summary: string | null; updated_at: string;
}
export interface ArtifactRow {
  id: string; system_run_id: string; member_id: string; task_id: string | null; node_id: string | null;
  type: string; name: string; version: number; content_hash: string; path: string | null; bytes: number | null; created_at: string;
}
export interface HandoffRow {
  id: string; system_run_id: string; from_member: string; to_member: string; task_id: string | null;
  status: 'pending' | 'accepted' | 'rejected'; artifact_ids_json: string | null; summary: string | null;
  reason: string | null; created_at: string; decided_at: string | null;
}
export interface TeamEventRow {
  seq: number; ts: string; level: 'info' | 'warn' | 'error'; kind: string;
  memberId?: string; nodeId?: string; payload: Record<string, unknown>;
}
export interface ResolvedMember {
  memberId: string; role: string; agentId: string; agentVersion: string; definitionHash: string; definitionJson: string;
}
export interface RunSnapshot {
  runId: string; systemId: string; systemName: string; systemVersion: string; systemDefinitionHash: string;
  workflowId: string; workflowName: string; workflowVersion: string; workflowDefinitionHash: string;
  mode: WorkflowMode; resolvedMembers: ResolvedMember[]; addedMembers?: ResolvedMember[];
  engineVersion: string; task: string;
  communication: { enabled: boolean; allowPeerToPeer: boolean; maxRounds: number; verbosity?: string; maxMessagesPerTurn?: number; maxBodyChars?: number };
  limits: Record<string, number>; createdAt: string;
}
export interface TeamRunDetail {
  run: TeamRunRow; snapshot: RunSnapshot | null; nodes: NodeRunRow[]; sessions: SessionRow[];
  artifacts: ArtifactRow[]; handoffs: HandoffRow[]; messageCount: number; active: boolean;
  progress: MemberProgressRow[];
}

export const TEAM_TERMINAL = ['done', 'failed', 'stopped'] as const;
export const isTerminal = (s: string | undefined): boolean => TEAM_TERMINAL.includes(s as never);

export const teamApi = {
  list: () => api<{ teams: TeamSummary[] }>('/api/teams').then((r) => r.teams),
  get: (id: string) => api<TeamDetail>(`/api/teams/${encodeURIComponent(id)}`),
  create: (definition: unknown) => api<TeamDetail>('/api/teams', { method: 'POST', body: { definition } }),
  update: (id: string, definition: unknown) => api<TeamDetail>(`/api/teams/${encodeURIComponent(id)}`, { method: 'PUT', body: { definition } }),
  validate: (id: string, definition: unknown) =>
    api<ValidationReport>(`/api/teams/${encodeURIComponent(id)}/validate`, { method: 'POST', body: { definition } }),
  publish: (id: string, version?: string) =>
    api<TeamDetail>(`/api/teams/${encodeURIComponent(id)}/publish`, { method: 'POST', body: version ? { version } : {} }),
  remove: (id: string) => api<{ deleted: boolean }>(`/api/teams/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  startRun: (id: string, body: { task: string; workflowId?: string; workspace?: string }) =>
    api<{ runId: string; status: string; workflowId: string; version: string; warnings: string[] }>(`/api/teams/${encodeURIComponent(id)}/runs`, { method: 'POST', body }),
  runs: (filter: { systemId?: string; status?: string; limit?: number } = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(filter)) if (v !== undefined && v !== '') p.set(k, String(v));
    return api<{ runs: TeamRunRow[] }>(`/api/team-runs?${p}`).then((r) => r.runs);
  },
  run: (id: string) => api<TeamRunDetail>(`/api/team-runs/${encodeURIComponent(id)}`),
  events: (id: string, after = 0) =>
    api<{ events: TeamEventRow[]; lastSeq: number }>(`/api/team-runs/${encodeURIComponent(id)}/events?after=${after}`),
  messages: (id: string, filter: { memberId?: string; type?: string } = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(filter)) if (v) p.set(k, String(v));
    return api<{ messages: TeamMessageRow[]; markdown: string }>(`/api/team-runs/${encodeURIComponent(id)}/messages?${p}`);
  },
  sendMessage: (id: string, body: { to: string[]; body: string; type?: TeamMessageType }) =>
    api<{ ok: boolean; messageId: string }>(`/api/team-runs/${encodeURIComponent(id)}/messages`, { method: 'POST', body }),
  stop: (id: string) => api<{ ok: boolean }>(`/api/team-runs/${encodeURIComponent(id)}/stop`, { method: 'POST' }),
  resume: (id: string) => api<{ ok: boolean }>(`/api/team-runs/${encodeURIComponent(id)}/resume`, { method: 'POST' }),
  decideApproval: (id: string, nodeId: string, decision: 'approved' | 'rejected', reason?: string) =>
    api<{ ok: boolean }>(`/api/team-runs/${encodeURIComponent(id)}/nodes/${encodeURIComponent(nodeId)}/approval`, { method: 'POST', body: { decision, reason } }),
  decideHandoff: (id: string, handoffId: string, decision: 'accepted' | 'rejected', reason?: string) =>
    api<{ ok: boolean }>(`/api/team-runs/${encodeURIComponent(id)}/handoffs/${encodeURIComponent(handoffId)}`, { method: 'POST', body: { decision, reason } }),
  artifactUrl: (runId: string, artifactId: string) =>
    `/api/team-runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}/content`,
  exportUrl: (runId: string) => `/api/team-runs/${encodeURIComponent(runId)}/export`,
};

/** Empty starting definition for "New team" — one planner → implementer pipeline. */
export function blankTeam(): AgentSystemDefinition {
  return {
    schemaVersion: '1.0',
    kind: 'agent-system',
    metadata: { id: '', name: '', version: '1.0.0', description: '' },
    team: { members: [] },
    orchestration: {
      defaultWorkflowId: 'delivery',
      communication: { enabled: true, allowPeerToPeer: true, persistMessages: true, maxRounds: 3, verbosity: 'concise', maxMessagesPerTurn: 2, maxBodyChars: 600 },
      workflows: [{
        workflowId: 'delivery',
        name: 'Sequential delivery',
        mode: 'sequential',
        version: '1.0.0',
        entryNodeId: 'start',
        limits: { maxNodeRuns: 12, maxIterations: 6, maxAttempts: 2, maxDurationMs: 1800000 },
        nodes: [
          { nodeId: 'start', type: 'agent-task' },
          { nodeId: 'done', type: 'terminal' },
        ],
        edges: [{ from: 'start', to: 'done' }],
      }],
    },
  };
}

export const MEMBER_AGENT_OPTIONS = '/api/agents';
