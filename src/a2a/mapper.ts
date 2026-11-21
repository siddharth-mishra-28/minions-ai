import { existsSync, readFileSync } from 'node:fs';
import type { ArtifactRow, TeamEvent, TeamMessage } from '../systems/types.js';
import type { TeamStore } from '../store/teams.js';
import type {
  A2AArtifact, A2AArtifactUpdateEvent, A2AMessage, A2APart, A2AStatusUpdateEvent,
  A2ATask, A2ATaskState, A2ATaskStatus,
} from './types.js';

export interface RunRow {
  id: string;
  status: string;
  system_id: string;
  system_name?: string | null;
  system_version?: string | null;
  workflow_id: string;
  workflow_version?: string | null;
  mode?: string | null;
  task?: string | null;
  workspace?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  error?: string | null;
  created_at?: string | null;
  snapshot_json?: string | null;
}

export function partsToText(parts: A2APart[] | undefined): string {
  return (parts ?? [])
    .map((p) => (p.kind === 'text' ? p.text : p.kind === 'data' ? JSON.stringify(p.data) : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

export function textPart(text: string): A2APart {
  return { kind: 'text', text };
}

export function textMessage(role: A2AMessage['role'], text: string, extra: Partial<A2AMessage> = {}): A2AMessage {
  return {
    kind: 'message',
    messageId: extra.messageId ?? `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    role,
    parts: [textPart(text)],
    ...extra,
    contextId: extra.contextId,
  };
}

export function stateFor(status: string): A2ATaskState {
  switch (status) {
    case 'queued': return 'submitted';
    case 'running': return 'working';
    case 'awaiting-approval': return 'input-required';
    case 'done': return 'completed';
    case 'stopped': return 'canceled';
    case 'failed':
    case 'interrupted': return 'failed';
    default: return 'unknown';
  }
}

function parseJson<T>(value: string | null | undefined): T | undefined {
  if (!value) return undefined;
  try { return JSON.parse(value) as T; } catch { return undefined; }
}

export function rowToMessage(row: TeamMessage & { to_members?: string[] }): A2AMessage {
  const parts = parseJson<A2APart[]>(row.parts_json ?? null);
  return {
    kind: 'message',
    messageId: row.message_id || row.id,
    role: row.from_member === 'operator' ? 'user' : 'agent',
    parts: parts?.length ? parts : [textPart(row.body)],
    contextId: row.context_id || row.system_run_id,
    taskId: row.task_id ?? undefined,
    metadata: {
      from: row.from_member,
      to: row.to_members ?? parseJson<string[]>(row.to_members_json) ?? [],
      type: row.type,
      nodeId: row.node_id,
      messageType: row.type,
      progress: parseJson<Record<string, unknown>>(row.progress_json ?? null),
      createdAt: row.created_at,
      updatedAt: row.updated_at ?? row.created_at,
      protocol: row.protocol ?? 'legacy',
    },
  };
}

export function artifactToA2A(row: ArtifactRow, includeContent = true): A2AArtifact {
  let content = '';
  if (includeContent && row.path && existsSync(row.path)) {
    try { content = readFileSync(row.path, 'utf8').slice(0, 20_000); } catch { content = ''; }
  }
  return {
    artifactId: row.id,
    name: row.name,
    description: `${row.type} v${row.version} by ${row.member_id}`,
    parts: content ? [textPart(content)] : [],
    metadata: {
      type: row.type, version: row.version, contentHash: row.content_hash,
      memberId: row.member_id, bytes: row.bytes, path: row.path, createdAt: row.created_at,
    },
  };
}

function lastAgentMessage(messages: A2AMessage[]): A2AMessage | undefined {
  return [...messages].reverse().find((m) => m.role === 'agent');
}

export function buildTask(store: TeamStore, run: RunRow, opts: { historyLimit?: number; includeArtifactContent?: boolean } = {}): A2ATask {
  const messages = store.listMessages(run.id, { limit: Math.min(1000, opts.historyLimit ?? 200) }).map(rowToMessage);
  const artifacts = store.listArtifacts(run.id).map((a) => artifactToA2A(a, opts.includeArtifactContent !== false));
  const progress = store.listMemberProgress(run.id);
  const state = stateFor(run.status);
  const last = lastAgentMessage(messages);
  const status: A2ATaskStatus = {
    state,
    timestamp: run.finished_at ?? new Date().toISOString(),
    message: last ?? textMessage('agent', run.error || `Run is ${run.status}`, { contextId: run.id }),
  };
  return {
    kind: 'task',
    id: run.id,
    contextId: run.id,
    status,
    artifacts,
    history: messages,
    metadata: {
      teamId: run.system_id,
      teamName: run.system_name ?? run.system_id,
      teamVersion: run.system_version,
      workflowId: run.workflow_id,
      workflowVersion: run.workflow_version,
      mode: run.mode,
      task: run.task,
      startedAt: run.started_at,
      finishedAt: run.finished_at,
      error: run.error,
      progress,
      nodeCount: store.listNodeRuns(run.id).length,
      createdAt: run.created_at,
    },
  };
}

export function eventToA2AUpdate(store: TeamStore, runId: string, event: TeamEvent): A2AStatusUpdateEvent | A2AArtifactUpdateEvent | undefined {
  const base = { taskId: runId, contextId: runId };
  switch (event.kind) {
    case 'run.complete':
      return { kind: 'status-update', ...base, status: { state: 'completed', timestamp: event.ts, message: textMessage('agent', 'Run completed.', { contextId: runId }) }, final: true };
    case 'run.failed':
    case 'run.crashed':
      return { kind: 'status-update', ...base, status: { state: 'failed', timestamp: event.ts, message: textMessage('agent', String(event.payload.error ?? 'Run failed.'), { contextId: runId }) }, final: true };
    case 'run.stop_requested':
      return { kind: 'status-update', ...base, status: { state: 'canceled', timestamp: event.ts, message: textMessage('agent', 'Run canceled.', { contextId: runId }) }, final: true };
    case 'run.interrupted':
      return { kind: 'status-update', ...base, status: { state: 'failed', timestamp: event.ts, message: textMessage('agent', 'Run interrupted; resume it to continue.', { contextId: runId }) }, final: true };
    case 'approval.requested':
      return { kind: 'status-update', ...base, status: { state: 'input-required', timestamp: event.ts, message: textMessage('agent', String(event.payload.prompt ?? 'Human approval required.'), { contextId: runId }) }, final: false };
    case 'artifact.publish': {
      const artifactId = String(event.payload.artifactId ?? '');
      const row = artifactId ? store.getArtifact(artifactId) : undefined;
      if (!row) return undefined;
      return { kind: 'artifact-update', ...base, artifact: artifactToA2A(row), append: false, lastChunk: true };
    }
    case 'message.sent': {
      const messageId = String(event.payload.messageId ?? '');
      const row = messageId ? store.listMessages(runId, { limit: 1000 }).find((m) => m.id === messageId) : undefined;
      if (!row) return undefined;
      return { kind: 'status-update', ...base, status: { state: 'working', timestamp: event.ts, message: rowToMessage(row) }, final: false };
    }
    case 'progress.updated':
      return {
        kind: 'status-update', ...base,
        status: {
          state: 'working', timestamp: event.ts,
          message: textMessage('agent', String(event.payload.summary ?? 'Progress updated.'), { contextId: runId }),
        },
        final: false,
        metadata: { memberId: event.memberId, progress: event.payload },
      };
    case 'turn.send':
      return {
        kind: 'status-update', ...base,
        status: {
          state: 'working', timestamp: event.ts,
          message: textMessage('agent', `${String(event.payload.memberId ?? 'A member')} started ${String(event.payload.nodeId ?? 'work')}.`, { contextId: runId }),
        },
        final: false,
        metadata: { memberId: event.memberId, nodeId: event.nodeId },
      };
    default:
      return undefined;
  }
}
