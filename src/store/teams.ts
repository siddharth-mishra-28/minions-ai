import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { SqliteAdapter } from './sqlite.js';
import type {
  AgentSystemRow, AgentSystemVersionRow, AgentWorkflowVersionRow, ArtifactRow, HandoffRow,
  MemberProgressRow, NodeRunRow, TeamEvent, TeamMessage, TeamMessageType, TeamRunStatus,
} from '../systems/types.js';

const now = (): string => new Date().toISOString();
const id = (prefix: string): string => `${prefix}_${randomUUID().slice(0, 10)}`;
/** events.payload_json ceiling — mirrors the run-event clamp so JSON stays parseable. */
const PAYLOAD_LIMIT = 20000;

export interface SystemRunInput {
  /** Caller-supplied id so the immutable snapshot can embed it before insert. */
  id?: string;
  systemId: string;
  systemName: string;
  systemVersion: string;
  workflowId: string;
  workflowVersion: string;
  mode: string;
  status?: TeamRunStatus;
  snapshotJson: string;
  engineVersion: string;
  task: string;
  workspace: string;
  limitsJson: string;
}

/**
 * All team persistence in one owner, sharing the adapter's SQLite connection (the
 * same pattern PlatformStore and the memory store use). No existing table is
 * altered; team runs reference `runs` rows by id for per-node execution history.
 */
export class TeamStore {
  private db: Database.Database;
  constructor(adapter: SqliteAdapter) {
    this.db = adapter.raw;
  }

  // ------------------------------------------------------------------ systems
  saveSystem(input: { id?: string; name: string; description?: string | null; status?: string; definitionJson: string; hash: string; version?: string | null }): string {
    const existing = input.id ? this.getSystem(input.id) : undefined;
    const rowId = input.id ?? existing?.id ?? id('system');
    const ts = now();
    if (existing) {
      this.db.prepare(`UPDATE agent_systems SET name=?, description=?, status=?, current_version=COALESCE(?, current_version), definition_json=?, definition_hash=?, updated_at=? WHERE id=?`)
        .run(input.name, input.description ?? null, input.status ?? existing.status, input.version ?? null, input.definitionJson, input.hash, ts, rowId);
    } else {
      this.db.prepare(`INSERT INTO agent_systems(id,name,description,status,current_version,definition_json,definition_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`)
        .run(rowId, input.name, input.description ?? null, input.status ?? 'draft', input.version ?? null, input.definitionJson, input.hash, ts, ts);
    }
    return rowId;
  }

  getSystem(systemId: string): AgentSystemRow | undefined {
    return this.db.prepare(`SELECT * FROM agent_systems WHERE id=?`).get(systemId) as AgentSystemRow | undefined;
  }

  listSystems(): (AgentSystemRow & { run_count: number; last_run_at: string | null })[] {
    return this.db.prepare(`
      SELECT s.*,
        (SELECT COUNT(*) FROM agent_system_runs r WHERE r.system_id = s.id) AS run_count,
        (SELECT MAX(r.created_at) FROM agent_system_runs r WHERE r.system_id = s.id) AS last_run_at
      FROM agent_systems s ORDER BY s.updated_at DESC`).all() as (AgentSystemRow & { run_count: number; last_run_at: string | null })[];
  }

  setSystemStatus(systemId: string, status: string): void {
    this.db.prepare(`UPDATE agent_systems SET status=?, updated_at=? WHERE id=?`).run(status, now(), systemId);
  }

  deleteSystem(systemId: string): boolean {
    const run = this.db.prepare(`SELECT COUNT(*) AS n FROM agent_system_runs WHERE system_id=?`).get(systemId) as { n: number };
    if (run.n > 0) return false; // history is immutable: never orphan runs
    this.db.prepare(`DELETE FROM agent_workflow_versions WHERE system_id=?`).run(systemId);
    this.db.prepare(`DELETE FROM agent_system_versions WHERE system_id=?`).run(systemId);
    return this.db.prepare(`DELETE FROM agent_systems WHERE id=?`).run(systemId).changes > 0;
  }

  // ----------------------------------------------------------------- versions
  publishSystemVersion(row: AgentSystemVersionRow): void {
    this.db.prepare(`INSERT INTO agent_system_versions(system_id,version,definition_json,definition_hash,published_at) VALUES(?,?,?,?,?)
      ON CONFLICT(system_id,version) DO UPDATE SET definition_json=excluded.definition_json, definition_hash=excluded.definition_hash, published_at=excluded.published_at`)
      .run(row.systemId, row.version, row.definitionJson, row.definitionHash, row.publishedAt);
    this.db.prepare(`UPDATE agent_systems SET status='published', current_version=?, updated_at=? WHERE id=?`).run(row.version, now(), row.systemId);
  }

  getSystemVersion(systemId: string, version: string): AgentSystemVersionRow | undefined {
    const r = this.db.prepare(`SELECT * FROM agent_system_versions WHERE system_id=? AND version=?`).get(systemId, version) as
      { system_id: string; version: string; definition_json: string; definition_hash: string; published_at: string } | undefined;
    return r ? { systemId: r.system_id, version: r.version, definitionJson: r.definition_json, definitionHash: r.definition_hash, publishedAt: r.published_at } : undefined;
  }

  listSystemVersions(systemId: string): { version: string; definition_hash: string; published_at: string }[] {
    return this.db.prepare(`SELECT version, definition_hash, published_at FROM agent_system_versions WHERE system_id=? ORDER BY published_at DESC`).all(systemId) as
      { version: string; definition_hash: string; published_at: string }[];
  }

  saveWorkflowVersion(row: AgentWorkflowVersionRow): void {
    this.db.prepare(`INSERT INTO agent_workflow_versions(system_id,workflow_id,version,definition_json,definition_hash,created_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(system_id,workflow_id,version) DO UPDATE SET definition_json=excluded.definition_json, definition_hash=excluded.definition_hash`)
      .run(row.systemId, row.workflowId, row.version, row.definitionJson, row.definitionHash, row.createdAt);
  }

  getWorkflowVersion(systemId: string, workflowId: string, version: string): AgentWorkflowVersionRow | undefined {
    const r = this.db.prepare(`SELECT * FROM agent_workflow_versions WHERE system_id=? AND workflow_id=? AND version=?`).get(systemId, workflowId, version) as
      { system_id: string; workflow_id: string; version: string; definition_json: string; definition_hash: string; created_at: string } | undefined;
    return r ? {
      systemId: r.system_id, workflowId: r.workflow_id, version: r.version,
      definitionJson: r.definition_json, definitionHash: r.definition_hash, createdAt: r.created_at,
    } : undefined;
  }

  listWorkflowVersions(systemId: string): { workflow_id: string; version: string; definition_hash: string; created_at: string }[] {
    return this.db.prepare(`SELECT workflow_id, version, definition_hash, created_at FROM agent_workflow_versions WHERE system_id=? ORDER BY created_at DESC`).all(systemId) as
      { workflow_id: string; version: string; definition_hash: string; created_at: string }[];
  }

  // --------------------------------------------------------------------- runs
  createSystemRun(input: SystemRunInput): string {
    const runId = input.id ?? id('team');
    this.db.prepare(`INSERT INTO agent_system_runs(id,system_id,system_name,system_version,workflow_id,workflow_version,mode,status,snapshot_json,engine_version,task,workspace,limits_json,started_at,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(runId, input.systemId, input.systemName, input.systemVersion, input.workflowId, input.workflowVersion, input.mode,
        input.status ?? 'queued', input.snapshotJson, input.engineVersion, input.task, input.workspace, input.limitsJson, null, now());
    return runId;
  }

  getSystemRun(runId: string): (Record<string, unknown> & { id: string; status: string }) | undefined {
    return this.db.prepare(`SELECT * FROM agent_system_runs WHERE id=?`).get(runId) as (Record<string, unknown> & { id: string; status: string }) | undefined;
  }

  listSystemRuns(filter: { systemId?: string; status?: string; limit?: number } = {}): Record<string, unknown>[] {
    const where: string[] = [];
    const vals: unknown[] = [];
    if (filter.systemId) { where.push('system_id=?'); vals.push(filter.systemId); }
    if (filter.status) { where.push('status=?'); vals.push(filter.status); }
    const limit = Math.min(500, Math.max(1, filter.limit ?? 100));
    const sql = `SELECT id,system_id,system_name,system_version,workflow_id,workflow_version,mode,status,task,workspace,started_at,finished_at,error,created_at
      FROM agent_system_runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ${limit}`;
    return this.db.prepare(sql).all(...vals) as Record<string, unknown>[];
  }

  markRunStarted(runId: string): void {
    this.db.prepare(`UPDATE agent_system_runs SET status='running', started_at=COALESCE(started_at, ?) WHERE id=?`).run(now(), runId);
  }

  setRunStatus(runId: string, status: TeamRunStatus, error?: string): void {
    const finished = ['done', 'failed', 'stopped', 'interrupted'].includes(status) ? now() : null;
    this.db.prepare(`UPDATE agent_system_runs SET status=?, error=?, finished_at=COALESCE(?, finished_at) WHERE id=?`).run(status, error ?? null, finished, runId);
  }

  setRunSnapshot(runId: string, snapshotJson: string): void {
    this.db.prepare(`UPDATE agent_system_runs SET snapshot_json=? WHERE id=?`).run(snapshotJson, runId);
  }

  /** Liveness signal: the executing engine beats this while a run is really in flight. */
  touchRun(runId: string): void {
    this.db.prepare(`UPDATE agent_system_runs SET heartbeat_at=? WHERE id=?`).run(now(), runId);
  }

  /**
   * Runs left mid-flight by a previous process — surfaced as `interrupted` on boot.
   * A run whose engine is still beating (heartbeat within the last 5 minutes) is
   * alive somewhere — e.g. a `minions-ai team run` in another process — and
   * must not be stolen from it. Runs that never beat (older rows, or a process that
   * died before its first beat) stay immediately recoverable.
   */
  staleRuns(): string[] {
    // ISO cutoff to match `now()`'s ISO strings — SQLite's datetime() format would
    // never compare correctly against them.
    return (this.db.prepare(`SELECT id FROM agent_system_runs WHERE status IN ('queued','running','awaiting-approval')
      AND (heartbeat_at IS NULL OR heartbeat_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 minutes'))`).all() as { id: string }[]).map((r) => r.id);
  }

  // ---------------------------------------------------------------- node runs
  startNodeRun(input: { systemRunId: string; nodeId: string; memberId: string | null; attempt: number; iteration: number; task?: string }): string {
    const nodeRunId = id('tn');
    this.db.prepare(`INSERT INTO agent_workflow_node_runs(id,system_run_id,node_id,member_id,attempt,iteration,status,run_id,task,output_json,error,started_at,finished_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(nodeRunId, input.systemRunId, input.nodeId, input.memberId, input.attempt, input.iteration, 'running', null, input.task ?? null, null, null, now(), null);
    return nodeRunId;
  }

  finishNodeRun(nodeRunId: string, status: string, opts: { runId?: string; outputJson?: string; error?: string } = {}): void {
    this.db.prepare(`UPDATE agent_workflow_node_runs SET status=?, run_id=COALESCE(?, run_id), output_json=?, error=?, finished_at=? WHERE id=?`)
      .run(status, opts.runId ?? null, opts.outputJson ?? null, opts.error ?? null, now(), nodeRunId);
  }

  listNodeRuns(runId: string): NodeRunRow[] {
    return this.db.prepare(`SELECT * FROM agent_workflow_node_runs WHERE system_run_id=? ORDER BY started_at, rowid`).all(runId) as NodeRunRow[];
  }

  /** Latest completed activation per node — the recovery checkpoint. */
  completedNodes(runId: string): string[] {
    return (this.db.prepare(`SELECT DISTINCT node_id FROM agent_workflow_node_runs WHERE system_run_id=? AND status='done'`).all(runId) as { node_id: string }[])
      .map((r) => r.node_id);
  }

  countNodeRuns(runId: string, nodeId: string): number {
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM agent_workflow_node_runs WHERE system_run_id=? AND node_id=?`).get(runId, nodeId) as { n: number };
    return r.n;
  }

  // ---------------------------------------------------------------- sessions
  upsertRunSession(input: { systemRunId: string; memberId: string; sessionId: string; agentId?: string; workspace?: string }): void {
    const ts = now();
    this.db.prepare(`INSERT INTO agent_run_sessions(system_run_id,member_id,copilot_session_id,agent_id,workspace,created_at,last_used_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(system_run_id,member_id) DO UPDATE SET copilot_session_id=excluded.copilot_session_id, last_used_at=excluded.last_used_at`)
      .run(input.systemRunId, input.memberId, input.sessionId, input.agentId ?? null, input.workspace ?? null, ts, ts);
  }

  getRunSession(runId: string, memberId: string): { copilot_session_id: string } | undefined {
    return this.db.prepare(`SELECT copilot_session_id FROM agent_run_sessions WHERE system_run_id=? AND member_id=?`).get(runId, memberId) as { copilot_session_id: string } | undefined;
  }

  listRunSessions(runId: string): Record<string, unknown>[] {
    return this.db.prepare(`SELECT * FROM agent_run_sessions WHERE system_run_id=? ORDER BY member_id`).all(runId) as Record<string, unknown>[];
  }

  // ---------------------------------------------------------------- messages
  addMessage(input: {
    systemRunId: string; threadId?: string | null; from: string; to: string[]; type: TeamMessageType;
    body: string; artifactIds?: string[]; replyTo?: string | null; taskId?: string | null; nodeId?: string | null;
    /** A2A envelope — optional so every legacy caller keeps working. */
    messageId?: string | null; contextId?: string | null; protocol?: string | null;
    parts?: unknown; progress?: unknown;
  }): string {
    const rowId = id('msg');
    const ts = now();
    const messageId = input.messageId?.trim() || rowId;
    // A2A clients retry with the same messageId; returning the existing row makes
    // message/send idempotent without duplicating the conversation.
    const prior = this.db.prepare(`SELECT id FROM agent_run_messages WHERE system_run_id=? AND message_id=?`).get(input.systemRunId, messageId) as { id: string } | undefined;
    if (prior) return prior.id;
    this.db.prepare(`INSERT INTO agent_run_messages(id,system_run_id,thread_id,from_member,to_members_json,type,body,artifact_ids_json,reply_to,task_id,node_id,created_at,delivered_at,message_id,context_id,protocol,parts_json,progress_json,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?)`)
      .run(rowId, input.systemRunId, input.threadId ?? null, input.from, JSON.stringify(input.to), input.type,
        input.body.slice(0, 20000), input.artifactIds?.length ? JSON.stringify(input.artifactIds) : null,
        input.replyTo ?? null, input.taskId ?? null, input.nodeId ?? null, ts,
        input.messageId?.trim() || null, input.contextId ?? input.systemRunId, input.protocol ?? 'a2a',
        input.parts ? JSON.stringify(input.parts) : null,
        input.progress ? JSON.stringify(input.progress) : null, ts);
    return rowId;
  }

  /**
   * One evolving status line per member per run. Status chatter must never grow the
   * transcript, so the newest row is updated in place instead of appended.
   */
  upsertStatusUpdate(input: {
    systemRunId: string; from: string; to: string[]; body: string; nodeId?: string | null;
    progress?: unknown; contextId?: string | null;
  }): { id: string; created: boolean } {
    const existing = this.db.prepare(`SELECT id FROM agent_run_messages WHERE system_run_id=? AND from_member=? AND type='status-update' ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(input.systemRunId, input.from) as { id: string } | undefined;
    const ts = now();
    if (existing) {
      this.db.prepare(`UPDATE agent_run_messages SET body=?, to_members_json=?, node_id=?, progress_json=?, updated_at=? WHERE id=?`)
        .run(input.body.slice(0, 20000), JSON.stringify(input.to), input.nodeId ?? null, input.progress ? JSON.stringify(input.progress) : null, ts, existing.id);
      return { id: existing.id, created: false };
    }
    const id2 = this.addMessage({
      systemRunId: input.systemRunId, from: input.from, to: input.to, type: 'status-update',
      body: input.body, nodeId: input.nodeId ?? null, progress: input.progress, contextId: input.contextId,
      messageId: `status-${input.systemRunId}-${input.from}`,
    });
    return { id: id2, created: true };
  }

  // ---------------------------------------------------------------- progress
  upsertMemberProgress(input: { systemRunId: string; memberId: string; status: string; percent: number; phase?: string | null; summary?: string | null }): void {
    const pct = Math.max(0, Math.min(100, Math.round(input.percent)));
    this.db.prepare(`INSERT INTO agent_run_member_progress(system_run_id,member_id,status,percent,phase,summary,updated_at)
      VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(system_run_id,member_id) DO UPDATE SET status=excluded.status, percent=excluded.percent, phase=excluded.phase, summary=excluded.summary, updated_at=excluded.updated_at`)
      .run(input.systemRunId, input.memberId, input.status, pct, input.phase ?? null, input.summary ?? null, now());
  }

  listMemberProgress(runId: string): MemberProgressRow[] {
    return this.db.prepare(`SELECT * FROM agent_run_member_progress WHERE system_run_id=? ORDER BY member_id`).all(runId) as MemberProgressRow[];
  }

  listMessages(runId: string, filter: { memberId?: string; threadId?: string; type?: string; limit?: number } = {}): (TeamMessage & { to_members: string[] })[] {
    const where = ['system_run_id=?'];
    const vals: unknown[] = [runId];
    if (filter.threadId) { where.push('thread_id=?'); vals.push(filter.threadId); }
    if (filter.type) { where.push('type=?'); vals.push(filter.type); }
    if (filter.memberId) {
      where.push('(from_member=? OR to_members_json LIKE ?)');
      vals.push(filter.memberId, `%"${filter.memberId}"%`);
    }
    const limit = Math.min(1000, Math.max(1, filter.limit ?? 500));
    const rows = this.db.prepare(`SELECT * FROM agent_run_messages WHERE ${where.join(' AND ')} ORDER BY created_at, rowid LIMIT ${limit}`).all(...vals) as TeamMessage[];
    return rows.map((r) => ({ ...r, to_members: safeArray(r.to_members_json) }));
  }

  /** Messages addressed to a member that have not been handed to a turn yet. */
  undeliveredFor(runId: string, memberId: string): (TeamMessage & { to_members: string[] })[] {
    const rows = this.db.prepare(`SELECT * FROM agent_run_messages WHERE system_run_id=? AND delivered_at IS NULL AND to_members_json LIKE ? ORDER BY created_at, rowid LIMIT 50`)
      .all(runId, `%"${memberId}"%`) as TeamMessage[];
    return rows.map((r) => ({ ...r, to_members: safeArray(r.to_members_json) }));
  }

  markDelivered(messageIds: string[]): void {
    if (!messageIds.length) return;
    const stmt = this.db.prepare(`UPDATE agent_run_messages SET delivered_at=? WHERE id=? AND delivered_at IS NULL`);
    const ts = now();
    const tx = this.db.transaction(() => { for (const m of messageIds) stmt.run(ts, m); });
    tx();
  }

  countUndelivered(runId: string): number {
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM agent_run_messages WHERE system_run_id=? AND delivered_at IS NULL`).get(runId) as { n: number };
    return r.n;
  }

  // --------------------------------------------------------------- artifacts
  addArtifact(input: {
    systemRunId: string; memberId: string; type: string; name: string; contentHash: string;
    path?: string | null; bytes?: number; taskId?: string | null; nodeId?: string | null;
  }): ArtifactRow {
    const existing = this.db.prepare(`SELECT MAX(version) AS v FROM agent_run_artifacts WHERE system_run_id=? AND member_id=? AND name=?`)
      .get(input.systemRunId, input.memberId, input.name) as { v: number | null };
    const row: ArtifactRow = {
      id: id('art'), system_run_id: input.systemRunId, member_id: input.memberId, task_id: input.taskId ?? null,
      node_id: input.nodeId ?? null, type: input.type, name: input.name, version: (existing.v ?? 0) + 1,
      content_hash: input.contentHash, path: input.path ?? null, bytes: input.bytes ?? null, created_at: now(),
    };
    this.db.prepare(`INSERT INTO agent_run_artifacts(id,system_run_id,member_id,task_id,node_id,type,name,version,content_hash,path,bytes,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(row.id, row.system_run_id, row.member_id, row.task_id, row.node_id, row.type, row.name, row.version, row.content_hash, row.path, row.bytes, row.created_at);
    return row;
  }

  listArtifacts(runId: string, filter: { memberId?: string; type?: string } = {}): ArtifactRow[] {
    const where = ['system_run_id=?'];
    const vals: unknown[] = [runId];
    if (filter.memberId) { where.push('member_id=?'); vals.push(filter.memberId); }
    if (filter.type) { where.push('type=?'); vals.push(filter.type); }
    return this.db.prepare(`SELECT * FROM agent_run_artifacts WHERE ${where.join(' AND ')} ORDER BY created_at DESC, name`).all(...vals) as ArtifactRow[];
  }

  getArtifact(artifactId: string): ArtifactRow | undefined {
    return this.db.prepare(`SELECT * FROM agent_run_artifacts WHERE id=?`).get(artifactId) as ArtifactRow | undefined;
  }

  // ---------------------------------------------------------------- handoffs
  addHandoff(input: {
    systemRunId: string; from: string; to: string; taskId?: string | null; status: 'pending' | 'accepted' | 'rejected';
    artifactIds?: string[]; summary?: string; reason?: string;
  }): string {
    const handoffId = id('ho');
    this.db.prepare(`INSERT INTO agent_run_handoffs(id,system_run_id,from_member,to_member,task_id,status,artifact_ids_json,summary,reason,created_at,decided_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(handoffId, input.systemRunId, input.from, input.to, input.taskId ?? null, input.status,
        input.artifactIds?.length ? JSON.stringify(input.artifactIds) : null, input.summary ?? null, input.reason ?? null,
        now(), input.status === 'pending' ? null : now());
    return handoffId;
  }

  listHandoffs(runId: string): HandoffRow[] {
    return this.db.prepare(`SELECT * FROM agent_run_handoffs WHERE system_run_id=? ORDER BY created_at`).all(runId) as HandoffRow[];
  }

  decideHandoff(handoffId: string, status: 'accepted' | 'rejected', reason?: string): boolean {
    return this.db.prepare(`UPDATE agent_run_handoffs SET status=?, reason=?, decided_at=? WHERE id=?`).run(status, reason ?? null, now(), handoffId).changes > 0;
  }

  // ------------------------------------------------------------------ events
  appendEvent(input: { systemRunId: string; kind: string; payload: Record<string, unknown>; level?: 'info' | 'warn' | 'error'; memberId?: string; nodeId?: string }): TeamEvent {
    const next = this.db.prepare(`SELECT COALESCE(MAX(seq),0)+1 AS seq FROM agent_run_events WHERE system_run_id=?`).get(input.systemRunId) as { seq: number };
    const payloadJson = JSON.stringify(input.payload ?? {});
    const ev: TeamEvent = {
      seq: next.seq, ts: now(), level: input.level ?? 'info', kind: input.kind,
      memberId: input.memberId, nodeId: input.nodeId, payload: input.payload ?? {},
    };
    this.db.prepare(`INSERT INTO agent_run_events(system_run_id,seq,ts,level,kind,member_id,node_id,payload_json) VALUES(?,?,?,?,?,?,?,?)`)
      .run(input.systemRunId, ev.seq, ev.ts, ev.level, ev.kind, ev.memberId ?? null, ev.nodeId ?? null,
        payloadJson.length > PAYLOAD_LIMIT ? JSON.stringify({ truncated: true, bytes: payloadJson.length, preview: payloadJson.slice(0, PAYLOAD_LIMIT - 200) }) : payloadJson);
    return ev;
  }

  listEvents(runId: string, afterSeq = 0): TeamEvent[] {
    const rows = this.db.prepare(`SELECT seq, ts, level, kind, member_id, node_id, payload_json FROM agent_run_events WHERE system_run_id=? AND seq>? ORDER BY seq`)
      .all(runId, afterSeq) as { seq: number; ts: string; level: 'info' | 'warn' | 'error'; kind: string; member_id: string | null; node_id: string | null; payload_json: string }[];
    return rows.map((r) => ({
      seq: r.seq, ts: r.ts, level: r.level, kind: r.kind,
      memberId: r.member_id ?? undefined, nodeId: r.node_id ?? undefined,
      payload: safeParse(r.payload_json),
    }));
  }

  /** Full audit bundle for one team run (export / replay). */
  exportRun(runId: string): Record<string, unknown> | undefined {
    const run = this.getSystemRun(runId);
    if (!run) return undefined;
    return {
      run,
      snapshot: safeParse(String(run.snapshot_json ?? '{}')),
      nodes: this.listNodeRuns(runId),
      sessions: this.listRunSessions(runId).map(({ copilot_session_id, ...rest }) => ({ ...rest, copilot_session_id })),
      messages: this.listMessages(runId, { limit: 1000 }),
      artifacts: this.listArtifacts(runId),
      handoffs: this.listHandoffs(runId),
      progress: this.listMemberProgress(runId),
      events: this.listEvents(runId),
    };
  }
}

function safeParse(json: string): Record<string, unknown> {
  try { return JSON.parse(json) as Record<string, unknown>; } catch { return { raw: json }; }
}

function safeArray(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch { return []; }
}
