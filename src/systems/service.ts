import { randomUUID } from 'node:crypto';
import { resolve, relative, isAbsolute } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { hashDefinition, findWorkflow, validateRunSnapshot, validateSystemDefinition } from './schema.js';
import { resolveTeamMembers, resolverFor } from './resolver.js';
import { validateTeam, type ValidationReport } from './validate.js';
import type { AgentSystemDefinition, AgentSystemRunSnapshot, WorkflowDefinition, WorkflowLimits } from './types.js';
import type { TeamEngine } from '../execution/team/engine.js';
import { ENGINE_VERSION } from '../execution/team/engine.js';
import type { TeamStore } from '../store/teams.js';
import type { SqliteAdapter } from '../store/sqlite.js';

export class TeamError extends Error {
  constructor(message: string, public readonly status: 400 | 404 | 409 = 400) { super(message); }
}

export interface TeamServiceOptions {
  db: SqliteAdapter;
  store: TeamStore;
  engine: TeamEngine;
  /** Server workspace root; team workspaces live under `<root>/teams/<runId>`. */
  workspaceRoot: string;
}

const DEFAULT_LIMITS: Required<WorkflowLimits> = {
  maxDurationMs: 45 * 60_000,
  maxNodeRuns: 24,
  maxIterations: 12,
  maxConcurrentTasks: 4,
  maxAttempts: 2,
  backoffMs: 750,
  retryBackoffMultiplier: 2,
};

const now = (): string => new Date().toISOString();

/**
 * Team lifecycle: validate → publish an immutable version → start a run that pins
 * exactly what was published.
 *
 * Publishing is the only way a version becomes runnable, and a run never reads the
 * mutable draft again — every member definition, workflow graph and limit is copied
 * into the run snapshot and version tables at start.
 */
export class TeamService {
  /**
   * Engine work started by this service instance, keyed by run id.
   *
   * `startRun`/`resume` intentionally return before the run finishes. A caller that owns
   * the process (the CLI) must be able to wait for the engine's *last write* — the run row
   * turns `done` before the closing `run.end` event is appended, so closing the database
   * on the status alone closes it under a write that is still in flight.
   */
  private readonly active = new Map<string, Promise<void>>();

  constructor(private opts: TeamServiceOptions) {}

  private track(runId: string, work: Promise<void>): void {
    const settled = work
      .catch((err) => { this.opts.store.setRunStatus(runId, 'failed', (err as Error).message); })
      .finally(() => { this.active.delete(runId); });
    this.active.set(runId, settled);
  }

  /** Resolves when this process has finished every write for the run. */
  async settled(runId: string): Promise<void> {
    await this.active.get(runId);
  }

  list(): Record<string, unknown>[] {
    return this.opts.store.listSystems().map((s) => ({
      id: s.id, name: s.name, description: s.description, status: s.status,
      currentVersion: s.current_version, updatedAt: s.updated_at, createdAt: s.created_at,
      runCount: s.run_count, lastRunAt: s.last_run_at,
      members: safeMembers(s.definition_json), workflows: safeWorkflows(s.definition_json),
    }));
  }

  get(systemId: string): Record<string, unknown> | undefined {
    const row = this.opts.store.getSystem(systemId);
    if (!row) return undefined;
    const definition = safeParse(row.definition_json);
    const report = definition ? this.validate(definition) : { ok: false, errors: ['definition is not valid JSON'], warnings: [] };
    return {
      id: row.id, name: row.name, description: row.description, status: row.status,
      currentVersion: row.current_version, definitionHash: row.definition_hash,
      hasDraftChanges: row.definition_hash !== (this.opts.store.getSystemVersion(row.id, row.current_version ?? '')?.definitionHash ?? ''),
      definition, definitionJson: row.definition_json,
      validation: report,
      versions: this.opts.store.listSystemVersions(row.id),
      workflowVersions: this.opts.store.listWorkflowVersions(row.id),
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  create(input: unknown): Record<string, unknown> {
    const { definition } = this.parseDefinition(input);
    const hash = this.pinMembersToRegistry(definition);
    const report = this.validate(definition);
    if (!report.ok) throw new TeamError(`team definition is invalid: ${report.errors.join('; ')}`);
    const existing = this.opts.store.listSystems().find((s) => s.id === definition.metadata.id);
    if (existing) throw new TeamError(`team '${definition.metadata.id}' already exists`, 409);
    const id = this.opts.store.saveSystem({
      id: definition.metadata.id, name: definition.metadata.name,
      description: definition.metadata.description ?? null, status: 'draft',
      definitionJson: JSON.stringify(definition), hash, version: null,
    });
    return this.get(id)!;
  }

  /** Update the editable draft. Published versions stay runnable and unchanged. */
  update(systemId: string, input: unknown): Record<string, unknown> {
    const row = this.opts.store.getSystem(systemId);
    if (!row) throw new TeamError(`team not found: ${systemId}`, 404);
    const { definition } = this.parseDefinition(input);
    const hash = this.pinMembersToRegistry(definition);
    const report = this.validate(definition);
    if (!report.ok) throw new TeamError(`team definition is invalid: ${report.errors.join('; ')}`);
    this.opts.store.saveSystem({
      id: systemId, name: definition.metadata.name, description: definition.metadata.description ?? null,
      status: 'draft', definitionJson: JSON.stringify(definition), hash,
      version: row.current_version ?? null,
    });
    return this.get(systemId)!;
  }

  remove(systemId: string): boolean {
    const row = this.opts.store.getSystem(systemId);
    if (!row) throw new TeamError(`team not found: ${systemId}`, 404);
    if (!this.opts.store.deleteSystem(systemId)) throw new TeamError('team has run history and cannot be deleted (runs are immutable); archive it instead', 409);
    return true;
  }

  validate(input: unknown): ValidationReport & { definitionHash?: string } {
    let definition: AgentSystemDefinition;
    try {
      definition = validateSystemDefinition(input).definition;
    } catch (err) {
      return { ok: false, errors: [(err as Error).message], warnings: [] };
    }
    const report = validateTeam(definition, { resolveAgent: resolverFor(this.opts.db) });
    return { ...report, definitionHash: hashDefinition(definition) };
  }

  /** Publish the current draft as an immutable, runnable version. */
  publish(systemId: string, versionOverride?: string): Record<string, unknown> {
    const row = this.opts.store.getSystem(systemId);
    if (!row) throw new TeamError(`team not found: ${systemId}`, 404);
    const definition = JSON.parse(row.definition_json) as AgentSystemDefinition;
    const report = this.validate(definition);
    if (!report.ok) throw new TeamError(`cannot publish: ${report.errors.join('; ')}`);
    const version = (versionOverride?.trim() || definition.metadata.version).trim();
    if (!/^[0-9A-Za-z._-]+$/.test(version)) throw new TeamError('version must be a simple semver-like string');
    definition.metadata.version = version;
    const hash = hashDefinition(definition);
    this.opts.store.saveSystem({ id: systemId, name: definition.metadata.name, description: definition.metadata.description ?? null, definitionJson: JSON.stringify(definition), hash, version });
    this.opts.store.publishSystemVersion({ systemId, version, definitionJson: JSON.stringify(definition), definitionHash: hash, publishedAt: now() });
    for (const workflow of definition.orchestration.workflows) {
      this.opts.store.saveWorkflowVersion({
        systemId, workflowId: workflow.workflowId, version: workflow.version ?? version,
        definitionJson: JSON.stringify(workflow), definitionHash: hashDefinition(workflow), createdAt: now(),
      });
    }
    return this.get(systemId)!;
  }

  /**
   * Create a run pinned to the published version. Returns immediately: execution is
   * asynchronous and observable through `/api/team-runs/:id`.
   */
  startRun(systemId: string, input: { task?: string; workflowId?: string; workspace?: string; limits?: Partial<WorkflowLimits> }): Record<string, unknown> {
    const row = this.opts.store.getSystem(systemId);
    if (!row) throw new TeamError(`team not found: ${systemId}`, 404);
    const version = row.current_version;
    if (!version) throw new TeamError('team has no published version — publish it before running', 409);
    const versionRow = this.opts.store.getSystemVersion(systemId, version);
    if (!versionRow) throw new TeamError(`published version ${version} is missing`, 409);
    const definition = JSON.parse(versionRow.definitionJson) as AgentSystemDefinition;
    const workflow = findWorkflow(definition, input.workflowId);
    const report = this.validate(definition);
    if (!report.ok) throw new TeamError(`team definition no longer resolves: ${report.errors.join('; ')}`);
    const resolved = resolveTeamMembers(definition, this.opts.db);
    if (resolved.errors.length) throw new TeamError(`cannot resolve team members: ${resolved.errors.join('; ')}`);

    const runId = `team_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const runWorkspace = this.runWorkspace(runId, input.workspace);
    mkdirSync(runWorkspace, { recursive: true });
    const limits: Required<WorkflowLimits> = { ...DEFAULT_LIMITS, ...(workflow.limits ?? {}) };
    for (const [key, value] of Object.entries(input.limits ?? {})) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) (limits as unknown as Record<string, number>)[key] = value;
    }
    const comms = definition.orchestration.communication ?? {};
    const snapshot: AgentSystemRunSnapshot = {
      schemaVersion: '1.0', kind: 'agent-run-snapshot', runId,
      systemId, systemName: definition.metadata.name, systemVersion: version,
      systemDefinitionHash: versionRow.definitionHash,
      workflowId: workflow.workflowId, workflowName: workflow.name,
      workflowVersion: workflow.version ?? version, workflowDefinitionHash: hashDefinition(workflow),
      mode: workflow.mode, resolvedMembers: resolved.members, engineVersion: ENGINE_VERSION,
      task: input.task?.trim() || definition.metadata.description || `Execute the ${definition.metadata.name} team objective.`,
      communication: {
        enabled: comms.enabled !== false,
        allowPeerToPeer: comms.allowPeerToPeer !== false,
        maxRounds: Math.max(1, Math.min(20, comms.maxRounds ?? 3)),
        verbosity: comms.verbosity === 'minimal' || comms.verbosity === 'normal' ? comms.verbosity : 'concise',
        maxMessagesPerTurn: Math.max(0, Math.min(20, comms.maxMessagesPerTurn ?? 2)),
        maxBodyChars: Math.max(120, Math.min(20000, comms.maxBodyChars ?? 600)),
      },
      limits, createdAt: now(),
    };
    const check = validateRunSnapshot(snapshot);
    if (!check.ok) throw new TeamError(`run snapshot is invalid: ${check.errors ?? 'unknown error'}`);

    this.opts.store.createSystemRun({
      id: runId, systemId, systemName: definition.metadata.name, systemVersion: version,
      workflowId: workflow.workflowId, workflowVersion: snapshot.workflowVersion, mode: workflow.mode,
      status: 'queued', snapshotJson: JSON.stringify(snapshot), engineVersion: ENGINE_VERSION,
      task: snapshot.task, workspace: runWorkspace, limitsJson: JSON.stringify(limits),
    });
    const declarations = new Map(definition.team.members.map((m) => [m.memberId, m]));
    for (const member of resolved.members) {
      const shared = declarations.get(member.memberId)?.workspace === 'shared';
      this.opts.store.upsertRunSession({
        systemRunId: runId, memberId: member.memberId, agentId: member.agentId,
        workspace: shared ? runWorkspace : `${runWorkspace}/members/${member.memberId}`,
        sessionId: `team-${runId}-${member.memberId}`.replace(/[^A-Za-z0-9_-]+/g, '-'),
      });
    }
    this.opts.store.appendEvent({ systemRunId: runId, kind: 'run.queued', payload: { systemId, version, workflowId: workflow.workflowId, warnings: resolved.warnings } });

    this.track(runId, this.opts.engine.start(runId));
    return { runId, status: 'queued', systemId, version, workflowId: workflow.workflowId, workflowVersion: snapshot.workflowVersion, workspace: runWorkspace, warnings: resolved.warnings };
  }

  stop(runId: string): void {
    const run = this.requireRun(runId);
    if (!this.opts.engine.stop(runId)) {
      this.opts.store.setRunStatus(runId, 'stopped', 'stopped before it started');
      this.opts.store.appendEvent({ systemRunId: runId, kind: 'run.stop_requested', payload: { status: String(run.status) } });
    }
  }

  resume(runId: string): void {
    const run = this.requireRun(runId);
    if (['done', 'failed', 'stopped'].includes(String(run.status))) throw new TeamError(`run ${runId} is ${String(run.status)} and cannot resume`, 409);
    if (this.opts.engine.isActive(runId)) return;
    // Flip the row back to running *before* the engine starts so a resumed run never
    // displays as interrupted while it is actively working.
    this.opts.store.setRunStatus(runId, 'running');
    this.opts.store.appendEvent({ systemRunId: runId, kind: 'run.resume', payload: {} });
    this.track(runId, this.opts.engine.start(runId));
  }

  approveNode(runId: string, nodeId: string, decision: 'approved' | 'rejected', reason?: string): void {
    this.requireRun(runId);
    if (!this.opts.engine.decideApproval(runId, nodeId, decision, reason)) {
      throw new TeamError(`run ${runId} is not waiting for approval on '${nodeId}'`, 409);
    }
  }

  /** Called once on boot: runs left mid-flight by a previous process are marked interrupted. */
  recoverStaleRuns(): string[] {
    const stale = this.opts.store.staleRuns().filter((id) => !this.opts.engine.isActive(id));
    for (const runId of stale) {
      this.opts.store.setRunStatus(runId, 'interrupted', 'server restarted while the run was in progress; resume to continue');
      this.opts.store.appendEvent({ systemRunId: runId, kind: 'run.interrupted', payload: { reason: 'server restart' }, level: 'warn' });
    }
    return stale;
  }

  exportRun(runId: string): Record<string, unknown> | undefined {
    return this.opts.store.exportRun(runId);
  }

  private requireRun(runId: string): Record<string, unknown> & { id: string; status: string } {
    const run = this.opts.store.getSystemRun(runId);
    if (!run) throw new TeamError(`team run not found: ${runId}`, 404);
    return run;
  }

  private runWorkspace(runId: string, requested?: string): string {
    const root = resolve(this.opts.workspaceRoot);
    if (!requested?.trim()) return resolve(root, 'teams', runId);
    const dir = resolve(requested.trim());
    const rel = relative(root, dir);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new TeamError(`workspace must be inside the server workspace (${root})`);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  }

  private parseDefinition(input: unknown): { definition: AgentSystemDefinition; hash: string } {
    const candidate = (input as { definition?: unknown })?.definition ?? input;
    if (!candidate || typeof candidate !== 'object') throw new TeamError('definition object is required');
    const { definition } = validateSystemDefinition(candidate);
    return { definition, hash: hashDefinition(definition) };
  }

  /**
   * Pin every member to the agent definition that actually lives in the registry
   * and return the new content hash — the publish contract: an immutable version
   * snapshots the registered definition, not the file's own hash. `init` pins the
   * shipped agents to the configured provider, so the two differ by one block.
   * Members that are not registered keep their pins; validation reports them.
   */
  private pinMembersToRegistry(definition: AgentSystemDefinition): string {
    const db = this.opts.db;
    for (const member of definition.team.members) {
      const wanted = String(member.agentRef.agentId ?? '');
      const name = wanted.includes('@') ? wanted.slice(0, wanted.lastIndexOf('@')) : wanted;
      const row = db.getAgent(wanted) ?? db.listAgents('all').map((a) => db.getAgent(a.id)).find((a) => a?.name === name);
      if (!row) continue;
      member.agentRef.agentId = row.id;
      member.agentRef.version = row.version;
      // Canonical single-prefix form — storage may hold the raw hex or a prefixed hash.
      const clean = String(row.definition_hash ?? '').trim().replace(/^sha256:/i, '');
      if (clean) member.agentRef.definitionHash = `sha256:${clean}`;
    }
    return hashDefinition(definition);
  }
}

function safeParse(json: string): AgentSystemDefinition | undefined {
  try { return JSON.parse(json) as AgentSystemDefinition; } catch { return undefined; }
}

function safeMembers(json: string): { memberId: string; role: string; agentId: string; pinned: boolean }[] {
  const def = safeParse(json);
  return (def?.team?.members ?? []).map((m) => ({ memberId: m.memberId, role: m.role, agentId: m.agentRef?.agentId ?? '', pinned: !!m.agentRef?.definitionHash }));
}

function safeWorkflows(json: string): { workflowId: string; name: string; mode: string }[] {
  const def = safeParse(json);
  return (def?.orchestration?.workflows ?? []).map((w) => ({ workflowId: w.workflowId, name: w.name, mode: w.mode }));
}

export type { WorkflowDefinition };
