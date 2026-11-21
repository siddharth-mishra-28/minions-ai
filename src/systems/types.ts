/**
 * Agent teams — the shapes that sit *beside* AgentDefinition v1.0.
 *
 * Nothing here changes agent-definition-1.0.json. An AgentSystemDefinition only
 * *references* independently stored agents (`agentRef`), pins an immutable
 * definition hash, and describes who works with whom and in what order.
 */

export type WorkflowMode = 'sequential' | 'parallel' | 'hierarchical' | 'hybrid';
export type WorkflowNodeType = 'agent-task' | 'manager' | 'join' | 'human-approval' | 'terminal';

export type ConditionOperator =
  | 'equals' | 'not-equals' | 'in' | 'contains' | 'exists'
  | 'gt' | 'lt' | 'gte' | 'lte' | 'matches';

export interface EdgeCondition {
  /** Dot path into the node output, e.g. `output.status` or `output.artifacts.length`. */
  path: string;
  operator: ConditionOperator;
  value?: unknown;
}

export interface AgentRef {
  /** Registered agent id name@version, or the bare name (resolved to a version). */
  agentId: string;
  /** Pinned definition version (metadata.version) when the caller wants a specific release. */
  version?: string;
  /** Pinned definition hash (`sha256:` prefix optional). Immutable for the life of a run. */
  definitionHash?: string;
}

export interface DelegationPolicy {
  enabled?: boolean;
  allowedMemberIds?: string[];
  maxDepth?: number;
  maxConcurrentDelegates?: number;
}

export interface TeamMember {
  memberId: string;
  /** Human-facing role in the team, e.g. "QA Engineer". */
  role: string;
  /** Reporting line (hierarchical validation). */
  reportsTo?: string;
  /**
   * Where this member works: `isolated` (default) gives it its own directory under
   * `members/<memberId>`; `shared` puts it in the run workspace so a delivery team
   * can build one repository together. Sessions and definitions stay independent.
   */
  workspace?: 'isolated' | 'shared';
  agentRef: AgentRef;
  delegation?: DelegationPolicy;
  capabilities?: { canReview?: boolean; canApprove?: boolean; canDelegate?: boolean };
  /** Extra run-scoped instruction appended to this member's task prompts. */
  instructions?: string;
}

export interface OutputContract {
  /** Artifact types this node must publish before the flow may advance. */
  artifactTypes?: string[];
  required?: boolean;
}

export interface WorkflowNode {
  nodeId: string;
  type: WorkflowNodeType;
  /** Required for agent-task / manager / human-approval nodes. */
  memberId?: string;
  label?: string;
  /** Node-specific task text appended to the member's brief. */
  task?: string;
  outputContract?: OutputContract;
  approval?: { prompt?: string; /** Role allowed to decide; informational. */ role?: string };
  join?: { mode?: 'all' | 'any' };
}

export interface WorkflowEdge {
  from: string;
  to: string;
  when?: EdgeCondition;
  label?: string;
}

export interface ManagerPolicy {
  memberId: string;
  maxDelegationDepth?: number;
  maxParallelTasks?: number;
  allowDynamicTaskCreation?: boolean;
  requireCompletionReview?: boolean;
}

export interface WorkflowLimits {
  /** Wall clock budget for the whole run. */
  maxDurationMs?: number;
  /** Activations allowed per node (rework protection). */
  maxNodeRuns?: number;
  /** Traversals allowed per edge (cycle protection). */
  maxIterations?: number;
  maxConcurrentTasks?: number;
  /** Attempts per node before the node is marked failed. */
  maxAttempts?: number;
  backoffMs?: number;
  retryBackoffMultiplier?: number;
}

export interface WorkflowDefinition {
  workflowId: string;
  name: string;
  mode: WorkflowMode;
  version?: string;
  entryNodeId: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  manager?: ManagerPolicy;
  limits?: WorkflowLimits;
}

export interface CommunicationPolicy {
  enabled?: boolean;
  mode?: 'orchestrator-mediated';
  allowPeerToPeer?: boolean;
  persistMessages?: boolean;
  /** Rounds of message delivery the engine will run before declaring the flow stalled. */
  maxRounds?: number;
  contextPolicy?: 'thread-and-artifacts' | 'artifacts-only';
  /**
   * Chat discipline. `minimal` allows only handoffs, blockers and decisions;
   * `concise` (default) also allows short review/status milestones; `normal` keeps
   * the historical behaviour. Progress is always tracked in the progress board, never
   * as a stream of chat messages.
   */
  verbosity?: 'minimal' | 'concise' | 'normal';
  /** Messages one member may emit in a single turn (tool + output.replies combined). */
  maxMessagesPerTurn?: number;
  /** Hard character cap for a persisted chat message body. */
  maxBodyChars?: number;
}

export interface Orchestration {
  defaultWorkflowId: string;
  communication?: CommunicationPolicy;
  workflows: WorkflowDefinition[];
}

export interface AgentSystemMetadata {
  id: string;
  name: string;
  version: string;
  description?: string;
  tags?: string[];
}

export interface AgentSystemDefinition {
  schemaVersion: '1.0';
  kind: 'agent-system';
  metadata: AgentSystemMetadata;
  team: { members: TeamMember[] };
  orchestration: Orchestration;
}

// ---------------------------------------------------------------------------
// Persistence-facing shapes
// ---------------------------------------------------------------------------

export interface ResolvedMember {
  memberId: string;
  role: string;
  agentId: string;
  agentVersion: string;
  definitionHash: string;
  definitionJson: string;
}

export interface AgentSystemRunSnapshot {
  schemaVersion: '1.0';
  kind: 'agent-run-snapshot';
  runId: string;
  systemId: string;
  systemName: string;
  systemVersion: string;
  systemDefinitionHash: string;
  workflowId: string;
  workflowName: string;
  workflowVersion: string;
  workflowDefinitionHash: string;
  mode: WorkflowMode;
  resolvedMembers: ResolvedMember[];
  /** Run-scoped additions requested by a manager (never mutates the published team). */
  addedMembers?: ResolvedMember[];
  engineVersion: string;
  task: string;
  communication: Required<Pick<CommunicationPolicy, 'enabled' | 'allowPeerToPeer' | 'maxRounds'>> & {
    verbosity: NonNullable<CommunicationPolicy['verbosity']>;
    maxMessagesPerTurn: number;
    maxBodyChars: number;
  };
  limits: Required<Pick<WorkflowLimits, 'maxDurationMs' | 'maxNodeRuns' | 'maxIterations' | 'maxConcurrentTasks' | 'maxAttempts' | 'backoffMs' | 'retryBackoffMultiplier'>>;
  createdAt: string;
}

export interface AgentSystemVersionRow {
  systemId: string;
  version: string;
  definitionJson: string;
  definitionHash: string;
  publishedAt: string;
}

export interface AgentWorkflowVersionRow {
  systemId: string;
  workflowId: string;
  version: string;
  definitionJson: string;
  definitionHash: string;
  createdAt: string;
}

export type TeamRunStatus =
  | 'queued' | 'running' | 'awaiting-approval' | 'interrupted'
  | 'done' | 'failed' | 'stopped';

export interface AgentSystemRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  current_version: string | null;
  definition_json: string;
  definition_hash: string | null;
  created_at: string;
  updated_at: string;
}

export interface NodeRunRow {
  id: string;
  system_run_id: string;
  node_id: string;
  member_id: string | null;
  attempt: number;
  iteration: number;
  status: string;
  run_id: string | null;
  task: string | null;
  output_json: string | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export type TeamMessageType =
  | 'message' | 'task-request' | 'clarification' | 'proposal'
  | 'review-request' | 'review-response' | 'decision' | 'handoff'
  | 'status-update' | 'escalation';

export interface TeamMessage {
  id: string;
  system_run_id: string;
  thread_id: string | null;
  from_member: string;
  to_members_json: string;
  type: TeamMessageType;
  body: string;
  artifact_ids_json: string | null;
  reply_to: string | null;
  task_id: string | null;
  node_id: string | null;
  created_at: string;
  delivered_at?: string | null;
  /** A2A envelope fields (null for legacy rows). */
  message_id?: string | null;
  context_id?: string | null;
  protocol?: string | null;
  parts_json?: string | null;
  progress_json?: string | null;
  updated_at?: string | null;
}

export interface MemberProgressRow {
  system_run_id: string;
  member_id: string;
  status: string;
  percent: number;
  phase: string | null;
  summary: string | null;
  updated_at: string;
}

export interface ArtifactRow {
  id: string;
  system_run_id: string;
  member_id: string;
  task_id: string | null;
  node_id: string | null;
  type: string;
  name: string;
  version: number;
  content_hash: string;
  path: string | null;
  bytes: number | null;
  created_at: string;
}

export interface HandoffRow {
  id: string;
  system_run_id: string;
  from_member: string;
  to_member: string;
  task_id: string | null;
  status: 'pending' | 'accepted' | 'rejected';
  artifact_ids_json: string | null;
  summary: string | null;
  reason: string | null;
  created_at: string;
  decided_at: string | null;
}

export interface TeamEvent {
  seq: number;
  ts: string;
  level: 'info' | 'warn' | 'error';
  kind: string;
  memberId?: string;
  nodeId?: string;
  payload: Record<string, unknown>;
}

/** Per-node result of one activation. Eventually fed to edge conditions as `output.*`. */
export interface NodeOutput {
  status: string;
  summary?: string;
  artifacts?: { id?: string; type: string; name: string; content?: string }[];
  replies?: { to: string | string[]; type?: TeamMessageType; body: string }[];
  decisions?: { memberId: string; decision: string; rationale?: string }[];
  tasks?: { id?: string; memberId: string; title: string; task: string; dependsOn?: string[] }[];
  /** Structured progress: shown on the board, never narrated in chat. */
  progress?: { percent?: number; phase?: string; summary?: string };
  message?: string;
  /** Raw model text, kept for the timeline and artifacts. */
  raw?: string;
  [key: string]: unknown;
}

export interface NodeRunResult {
  nodeId: string;
  memberId: string | null;
  status: 'done' | 'failed' | 'blocked' | 'skipped';
  output: NodeOutput;
  runId?: string;
  error?: string;
  attempts: number;
}
