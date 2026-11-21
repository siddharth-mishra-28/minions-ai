import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { AgentDefinition } from '../../core/types.js';
import { hydrateMember, resolveAgentRef, type AgentLookup } from '../../systems/resolver.js';
import { findWorkflow } from '../../systems/schema.js';
import type {
  AgentSystemDefinition, AgentSystemRunSnapshot, ArtifactRow, CommunicationPolicy, NodeOutput,
  NodeRunResult, ResolvedMember, TeamMember, WorkflowDefinition, WorkflowLimits, WorkflowNode,
} from '../../systems/types.js';
import type { TeamStore } from '../../store/teams.js';
import { artifactsDirFor, memberWorkspaceFor, publishArtifact } from './artifacts.js';
import { satisfiedEdges } from './conditions.js';
import type { MemberExecutor, TeamTool } from './executor.js';
import { OUTPUT_CONTRACT_PROMPT, parseNodeOutput, renderInbox } from './output.js';
import { deserializeMessageTargets } from './messages.js';
import { buildTeamTools, messagingAllowed } from './tools.js';

export const ENGINE_VERSION = '1.0.0';

/** Statuses that mean the node did not deliver; a terminal edge from one is a failure. */
const FAILURE_STATUSES = new Set(['failed', 'blocked', 'rejected', 'changes-requested', 'stopped', 'cancelled']);

/** Statuses a manager may use to declare the objective met. */
const SUCCESS_STATUSES = new Set(['done', 'complete', 'completed', 'accepted', 'approved', 'passed']);

const DEFAULT_LIMITS: Required<WorkflowLimits> = {
  maxDurationMs: 45 * 60_000,
  maxNodeRuns: 24,
  maxIterations: 12,
  maxConcurrentTasks: 4,
  maxAttempts: 2,
  backoffMs: 750,
  retryBackoffMultiplier: 2,
};

export interface TeamEngineOptions {
  store: TeamStore;
  executor: MemberExecutor;
  /** Definition registry, used only for manager-requested extra members. */
  lookup: AgentLookup;
  /** Root under which `<runId>/members/<memberId>` workspaces live. */
  workspaceRoot: string;
  /** Optional SSE/tail hook: called for every persisted team event. */
  onEvent?: (runId: string, event: { seq: number; kind: string; ts: string; level: string; memberId?: string; nodeId?: string; payload: Record<string, unknown> }) => void;
  /** Per-member long-term memory, resolved from the member's own definition. */
  memoryFor?: (input: { definition: AgentDefinition; memberId: string; agentId: string; task: string; runId: string }) => import('../../memory/runtime.js').MemoryRuntime | undefined;
}

interface MemberContext {
  memberId: string;
  role: string;
  agentId: string;
  definitionHash: string;
  definition: AgentDefinition;
  portable: string;
  sessionId: string;
  workspace: string;
  declaration?: TeamMember;
}

interface RunContext {
  runId: string;
  row: Record<string, unknown>;
  snapshot: AgentSystemRunSnapshot;
  system: AgentSystemDefinition;
  workflow: WorkflowDefinition;
  members: Map<string, MemberContext>;
  limits: Required<WorkflowLimits>;
  policy: CommunicationPolicy;
  runWorkspace: string;
  artifactsDir: string;
  nodeCounts: Map<string, number>;
  edgeCounts: Map<string, number>;
}

interface Control {
  abort: AbortController;
  approvals: Map<string, { decision: string; reason?: string }>;
  waiters: Map<string, () => void>;
  startedAt: number;
}

class ActivationError extends Error {}

/**
 * Executes one team run.
 *
 * The engine is a guarded, persisted DAG walker: every activation has a row, every
 * transition an event, every session a stable id. It supports all four execution
 * models without special cases — sequential, parallel and hybrid are just different
 * edge graphs, and `hierarchical` adds manager delegation rounds on the manager node.
 *
 * Nothing here can alter an agent definition: members are hydrated from the
 * snapshot's pinned, immutable definition bodies.
 */
export class TeamEngine {
  private controls = new Map<string, Control>();
  private locks = new Map<string, Promise<unknown>>();

  constructor(private opts: TeamEngineOptions) {}

  isActive(runId: string): boolean {
    return this.controls.has(runId);
  }

  activeRunIds(): string[] {
    return [...this.controls.keys()];
  }

  /** Start (or resume) a run. Resolves when the run settles. */
  async start(runId: string): Promise<void> {
    if (this.controls.has(runId)) return;
    const control: Control = { abort: new AbortController(), approvals: new Map(), waiters: new Map(), startedAt: Date.now() };
    this.controls.set(runId, control);
    // Liveness heartbeat: tells every other process (a booting server's stale-run
    // recovery, another CLI) that this engine is still executing the run. A turn can
    // be silent for minutes, so event recency cannot serve as the signal.
    const beat = (): void => { try { this.opts.store.touchRun(runId); } catch { /* database closed */ } };
    beat();
    const heartbeat = setInterval(beat, 30_000);
    try {
      await this.execute(runId, control);
    } catch (err) {
      this.opts.store.setRunStatus(runId, 'failed', (err as Error).message);
      this.persistEvent(runId, 'run.crashed', { error: (err as Error).message }, 'error');
    } finally {
      clearInterval(heartbeat);
      this.controls.delete(runId);
    }
  }

  stop(runId: string): boolean {
    const control = this.controls.get(runId);
    if (!control) return false;
    control.abort.abort();
    this.opts.store.setRunStatus(runId, 'stopped');
    this.persistEvent(runId, 'run.stop_requested', {}, 'warn');
    return true;
  }

  /** Resolve a `human-approval` node gate. Returns false when no run is waiting on it. */
  decideApproval(runId: string, nodeId: string, decision: 'approved' | 'rejected', reason?: string): boolean {
    const control = this.controls.get(runId);
    if (!control) return false;
    control.approvals.set(nodeId, { decision, reason });
    this.persistEvent(runId, 'approval.decision', { nodeId, decision, reason }, decision === 'approved' ? 'info' : 'warn', undefined, nodeId);
    control.waiters.get(nodeId)?.();
    return true;
  }

  // ------------------------------------------------------------------ execution

  private async execute(runId: string, control: Control): Promise<void> {
    const ctx = await this.loadRun(runId);
    if (!ctx) return;
    const store = this.opts.store;
    const status = String(ctx.row.status ?? 'queued');
    if (['done', 'failed', 'stopped'].includes(status)) return;

    store.markRunStarted(runId);
    // A previous process may have died mid-node, leaving rows that still claim to be
    // running. Those attempts are history now: close them so the resumed ledger has no
    // phantom work and every finished node row reflects an attempt that really ended.
    for (const stale of store.listNodeRuns(runId).filter((n) => n.status === 'running')) {
      store.finishNodeRun(stale.id, 'interrupted', { error: 'the process exited while this node was running; superseded by the resumed attempt' });
    }
    this.persistEvent(runId, 'run.start', {
      systemId: ctx.snapshot.systemId, workflowId: ctx.workflow.workflowId, mode: ctx.workflow.mode,
      members: [...ctx.members.keys()], task: ctx.snapshot.task,
    });
    for (const [memberId, m] of ctx.members) {
      // Upsert (not insert-if-missing): a resumed run must record the workspace the
      // current declaration actually resolves to, including shared-team changes.
      store.upsertRunSession({ systemRunId: runId, memberId, sessionId: m.sessionId, agentId: m.agentId, workspace: m.workspace });
    }

    const pending = this.initialFrontier(ctx);
    let terminalSeen = false;
    let failure: string | undefined;

    while (pending.size) {
      if (control.abort.signal.aborted) { store.setRunStatus(runId, 'stopped'); return; }
      if (Date.now() - control.startedAt > ctx.limits.maxDurationMs) {
        failure = `maximum run duration (${ctx.limits.maxDurationMs} ms) exceeded`;
        break;
      }
      const wave = [...pending].slice(0, Math.max(1, ctx.limits.maxConcurrentTasks));
      for (const id of wave) pending.delete(id);
      this.persistEvent(runId, 'frontier', { pending: [...wave, ...pending] });

      const results = await Promise.all(wave.map((nodeId) => this.activate(ctx, nodeId, control)));
      for (const result of results) {
        if (control.abort.signal.aborted) break;
        const node = ctx.workflow.nodes.find((n) => n.nodeId === result.nodeId);
        if (node?.type === 'terminal') { terminalSeen = true; continue; }
        if (!node) continue;

        if (result.status === 'failed' && result.output.status !== 'failed') result.output.status = 'failed';
        const edges = satisfiedEdges(ctx.workflow.edges, result.nodeId, result.output);
        if (!edges.length) {
          failure = `node '${result.nodeId}' ended with status '${result.output.status}'${result.error ? ` (${result.error})` : ''} and no transition matched`;
          continue;
        }
        for (const edge of edges) {
          const key = `${edge.from}->${edge.to}`;
          const used = (ctx.edgeCounts.get(key) ?? 0) + 1;
          if (used > ctx.limits.maxIterations) {
            this.persistEvent(runId, 'limit.edge', { edge: key, used, max: ctx.limits.maxIterations }, 'warn', result.memberId ?? undefined, result.nodeId);
            continue;
          }
          ctx.edgeCounts.set(key, used);
          this.persistEvent(runId, 'edge.fire', { from: edge.from, to: edge.to, label: edge.label, status: result.output.status }, 'info', result.memberId ?? undefined, result.nodeId);

          const target = ctx.workflow.nodes.find((n) => n.nodeId === edge.to);
          if (!target) continue;
          // A terminal reached from a failure status is not a delivery: the run failed.
          if (target.type === 'terminal' && FAILURE_STATUSES.has(String(result.output.status))) {
            failure = `node '${result.nodeId}' ended ${String(result.output.status)}; the workflow's terminal step does not count as delivered`;
            this.persistEvent(runId, 'run.terminal_on_failure', { nodeId: result.nodeId, status: result.output.status }, 'error', result.memberId ?? undefined, result.nodeId);
            break;
          }
          this.recordHandoff(ctx, result, edge.to, target);
          const targetMember = target.memberId ? ctx.members.get(target.memberId) : undefined;
          if (target.type !== 'terminal') {
            const prior = ctx.nodeCounts.get(target.nodeId) ?? 0;
            if (prior >= ctx.limits.maxNodeRuns) {
              this.persistEvent(runId, 'limit.node', { nodeId: target.nodeId, used: prior, max: ctx.limits.maxNodeRuns }, 'warn', target.memberId, target.nodeId);
              continue;
            }
          }
          pending.add(target.nodeId);
          if (targetMember && target.type !== 'terminal') {
            this.persistEvent(runId, 'member.assigned', { memberId: targetMember.memberId, nodeId: target.nodeId }, 'info', targetMember.memberId, target.nodeId);
          }
        }
      }
      if (terminalSeen || failure) break;
    }

    if (control.abort.signal.aborted) { store.setRunStatus(runId, 'stopped'); return; }
    if (terminalSeen) {
      store.setRunStatus(runId, 'done');
      this.persistEvent(runId, 'run.complete', { status: 'done' });
      return;
    }
    const reason = failure ?? 'workflow settled without reaching a terminal node';
    store.setRunStatus(runId, 'failed', reason);
    this.persistEvent(runId, 'run.failed', { error: reason }, 'error');
  }

  /** Resume from the last persisted frontier; otherwise start at the entry node. */
  private initialFrontier(ctx: RunContext): Set<string> {
    const events = this.opts.store.listEvents(ctx.runId);
    const frontier = [...events].reverse().find((e) => e.kind === 'frontier');
    if (frontier) {
      const pending = Array.isArray(frontier.payload.pending) ? (frontier.payload.pending as unknown[]).map(String) : [];
      const valid = pending.filter((id) => ctx.workflow.nodes.some((n) => n.nodeId === id));
      if (valid.length) return new Set(valid);
    }
    const done = new Set(this.opts.store.completedNodes(ctx.runId));
    if (done.size) {
      // No frontier recorded (older run): restart from nodes that were mid-flight,
      // otherwise replay the entry node with its persisted conversation session.
      const running = this.opts.store.listNodeRuns(ctx.runId).filter((n) => n.status === 'running').map((n) => n.node_id);
      if (running.length) return new Set(running);
    }
    return new Set([ctx.workflow.entryNodeId]);
  }

  private async loadRun(runId: string): Promise<RunContext | undefined> {
    const store = this.opts.store;
    const row = store.getSystemRun(runId);
    if (!row) return undefined;
    let snapshot: AgentSystemRunSnapshot;
    try { snapshot = JSON.parse(String(row.snapshot_json)) as AgentSystemRunSnapshot; } catch { return undefined; }
    const systemVersion = store.getSystemVersion(snapshot.systemId, snapshot.systemVersion);
    if (!systemVersion) throw new Error(`team version ${snapshot.systemId}@${snapshot.systemVersion} is missing; the run cannot resume`);
    const system = JSON.parse(systemVersion.definitionJson) as AgentSystemDefinition;
    const workflowVersion = store.getWorkflowVersion(snapshot.systemId, snapshot.workflowId, snapshot.workflowVersion);
    const workflow = workflowVersion ? (JSON.parse(workflowVersion.definitionJson) as WorkflowDefinition) : findWorkflow(system, snapshot.workflowId);

    const runWorkspace = resolve(String(row.workspace ?? resolve(this.opts.workspaceRoot, 'teams', runId)));
    const members = new Map<string, MemberContext>();
    const allResolved = [...snapshot.resolvedMembers, ...(snapshot.addedMembers ?? [])];
    for (const resolved of allResolved) {
      members.set(resolved.memberId, await this.memberContext(runId, resolved, system, runWorkspace));
    }
    const limits: Required<WorkflowLimits> = { ...DEFAULT_LIMITS, ...(workflow.limits ?? {}), ...(snapshot.limits ?? {}) };
    for (const [k, v] of Object.entries(limits)) if (typeof v !== 'number' || !Number.isFinite(v)) (limits as unknown as Record<string, number>)[k] = DEFAULT_LIMITS[k as keyof WorkflowLimits] as number;

    return {
      runId, row, snapshot, system, workflow, members, limits,
      policy: {
        enabled: snapshot.communication?.enabled ?? system.orchestration.communication?.enabled ?? true,
        allowPeerToPeer: snapshot.communication?.allowPeerToPeer ?? system.orchestration.communication?.allowPeerToPeer ?? true,
        persistMessages: system.orchestration.communication?.persistMessages ?? true,
        maxRounds: snapshot.communication?.maxRounds ?? system.orchestration.communication?.maxRounds ?? 3,
        mode: 'orchestrator-mediated',
        verbosity: snapshot.communication?.verbosity ?? system.orchestration.communication?.verbosity ?? 'concise',
        maxMessagesPerTurn: snapshot.communication?.maxMessagesPerTurn ?? system.orchestration.communication?.maxMessagesPerTurn ?? 2,
        maxBodyChars: snapshot.communication?.maxBodyChars ?? system.orchestration.communication?.maxBodyChars ?? 600,
      },
      runWorkspace,
      artifactsDir: artifactsDirFor(runWorkspace),
      nodeCounts: new Map(),
      edgeCounts: this.edgeCounts(runId),
    };
  }

  private async memberContext(runId: string, resolved: ResolvedMember, system: AgentSystemDefinition, runWorkspace: string): Promise<MemberContext> {
    const hydrated = hydrateMember(resolved);
    const session = this.opts.store.getRunSession(runId, resolved.memberId);
    const sessionId = session?.copilot_session_id ?? `team-${runId}-${resolved.memberId}-${randomUUID().slice(0, 8)}`.replace(/[^A-Za-z0-9_-]+/g, '-');
    const declaration = system.team.members.find((m) => m.memberId === resolved.memberId);
    return {
      memberId: resolved.memberId,
      role: resolved.role || declaration?.role || resolved.memberId,
      agentId: resolved.agentId,
      definitionHash: hydrated.hash,
      definition: hydrated.definition,
      portable: hydrated.portable,
      sessionId,
      // A delivery team shares one repository; the default stays isolated so
      // existing teams and their per-member directories are unchanged.
      workspace: declaration?.workspace === 'shared' ? resolve(runWorkspace) : memberWorkspaceFor(runWorkspace, resolved.memberId),
      declaration,
    };
  }

  private edgeCounts(runId: string): Map<string, number> {
    const counts = new Map<string, number>();
    for (const ev of this.opts.store.listEvents(runId)) {
      if (ev.kind !== 'edge.fire') continue;
      const key = `${String(ev.payload.from)}->${String(ev.payload.to)}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }

  // -------------------------------------------------------------------- nodes

  private async activate(ctx: RunContext, nodeId: string, control: Control): Promise<NodeRunResult> {
    const node = ctx.workflow.nodes.find((n) => n.nodeId === nodeId);
    if (!node) return { nodeId, memberId: null, status: 'failed', output: { status: 'failed', summary: `unknown node ${nodeId}` }, error: `unknown node ${nodeId}`, attempts: 0 };
    const started = Date.now();
    ctx.nodeCounts.set(nodeId, (ctx.nodeCounts.get(nodeId) ?? 0) + 1);
    this.persistEvent(ctx.runId, 'node.start', { nodeId, type: node.type, memberId: node.memberId, label: node.label }, 'info', node.memberId, nodeId);

    try {
      if (node.type === 'terminal') {
        this.persistEvent(ctx.runId, 'node.end', { nodeId, status: 'done', ms: Date.now() - started }, 'info', undefined, nodeId);
        return { nodeId, memberId: null, status: 'done', output: { status: 'done', summary: 'terminal' }, attempts: 1 };
      }
      if (node.type === 'human-approval') return await this.runApprovalNode(ctx, node, control);
      if (node.type === 'join') {
        this.persistEvent(ctx.runId, 'node.end', { nodeId, status: 'done', ms: Date.now() - started }, 'info', node.memberId, nodeId);
        return { nodeId, memberId: node.memberId ?? null, status: 'done', output: { status: 'done', summary: 'join' }, attempts: 1 };
      }
      if (node.type === 'manager') return await this.runManagerNode(ctx, node, control);
      return await this.runAgentNode(ctx, node, control);
    } catch (err) {
      const message = (err as Error).message;
      const aborted = control.abort.signal.aborted;
      this.persistEvent(ctx.runId, aborted ? 'node.aborted' : 'node.error', { nodeId, error: message, ms: Date.now() - started }, aborted ? 'warn' : 'error', node.memberId, nodeId);
      return { nodeId, memberId: node.memberId ?? null, status: aborted ? 'skipped' : 'failed', output: { status: aborted ? 'stopped' : 'failed', summary: message }, error: message, attempts: 1 };
    }
  }

  private async runAgentNode(ctx: RunContext, node: WorkflowNode, control: Control): Promise<NodeRunResult> {
    if (!node.memberId) throw new ActivationError(`node '${node.nodeId}' has no member`);
    const member = ctx.members.get(node.memberId);
    if (!member) throw new ActivationError(`node '${node.nodeId}' references member '${node.memberId}' that is not in this run`);
    const task = node.task?.trim() || `${member.role} responsibility for the team task.`;
    const { output, nodeRunId, artifacts } = await this.runTurn(ctx, node, member, { task, control, contract: node.outputContract });
    const status: NodeRunResult['status'] = output.status === 'failed' || output.status === 'blocked' ? 'blocked' : 'done';
    return { nodeId: node.nodeId, memberId: member.memberId, status, output, runId: nodeRunId, attempts: 1, artifacts } as NodeRunResult;
  }

  private async runApprovalNode(ctx: RunContext, node: WorkflowNode, control: Control): Promise<NodeRunResult> {
    const nodeRunId = this.opts.store.startNodeRun({ systemRunId: ctx.runId, nodeId: node.nodeId, memberId: node.memberId ?? null, attempt: 1, iteration: 1, task: node.approval?.prompt ?? node.label });
    this.opts.store.setRunStatus(ctx.runId, 'awaiting-approval');
    this.persistEvent(ctx.runId, 'approval.requested', { nodeId: node.nodeId, prompt: node.approval?.prompt ?? 'Approve to continue' }, 'warn', node.memberId, node.nodeId);
    const decision = await this.waitForApproval(ctx, node.nodeId, control);
    this.opts.store.setRunStatus(ctx.runId, 'running');
    const status = decision?.decision === 'approved' ? 'approved' : 'changes-requested';
    const output: NodeOutput = { status, summary: decision?.reason ?? decision?.decision ?? 'approval not provided' };
    this.opts.store.finishNodeRun(nodeRunId, 'done', { outputJson: JSON.stringify(output) });
    this.persistEvent(ctx.runId, 'node.end', { nodeId: node.nodeId, status, summary: output.summary }, 'info', node.memberId, node.nodeId);
    return { nodeId: node.nodeId, memberId: node.memberId ?? null, status: 'done', output, runId: nodeRunId, attempts: 1 };
  }

  private waitForApproval(ctx: RunContext, nodeId: string, control: Control): Promise<{ decision: string; reason?: string } | undefined> {
    const ready = control.approvals.get(nodeId);
    if (ready) { control.approvals.delete(nodeId); return Promise.resolve(ready); }
    return new Promise((resolvePromise) => {
      const timer = setTimeout(() => finish(undefined), Math.min(ctx.limits.maxDurationMs, 30 * 60_000));
      const onAbort = (): void => finish(undefined);
      const finish = (value: { decision: string; reason?: string } | undefined): void => {
        clearTimeout(timer);
        control.waiters.delete(nodeId);
        control.abort.signal.removeEventListener('abort', onAbort);
        resolvePromise(value);
      };
      control.waiters.set(nodeId, () => finish(control.approvals.get(nodeId)) );
      control.abort.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Manager node: run the manager turn, execute the tasks it delegated, then bring
   * the results back for review — up to `maxDelegationDepth` rounds. Extra members
   * requested by the manager are added to this run only (snapshot.addedMembers).
   */
  private async runManagerNode(ctx: RunContext, node: WorkflowNode, control: Control): Promise<NodeRunResult> {
    const memberId = node.memberId ?? ctx.workflow.manager?.memberId;
    if (!memberId) throw new ActivationError(`manager node '${node.nodeId}' has no manager member`);
    const manager = ctx.members.get(memberId);
    if (!manager) throw new ActivationError(`manager '${memberId}' is not part of the run`);
    const maxRounds = Math.max(0, ctx.workflow.manager?.maxDelegationDepth ?? manager.declaration?.delegation?.maxDepth ?? 2);
    const maxParallel = Math.max(1, ctx.workflow.manager?.maxParallelTasks ?? manager.declaration?.delegation?.maxConcurrentDelegates ?? 3);
    const allowDynamic = ctx.workflow.manager?.allowDynamicTaskCreation !== false;

    let lastRunId: string | undefined;
    let output: NodeOutput = { status: 'done' };
    let delegated = 0;
    let nudged = false;
    let taskText = node.task?.trim()
      ? node.task
      : `Accept the team task, plan it, and delegate it to the specialists who should own each workstream.`;

    for (let round = 0; round <= maxRounds; round++) {
      const turn = await this.runTurn(ctx, node, manager, { task: taskText, control, contract: round === 0 ? node.outputContract : undefined, managerRound: round });
      lastRunId = turn.nodeRunId;
      output = turn.output;

      if (allowDynamic) await this.applyRequestedMembers(ctx, node, manager, output, control);

      const tasks = Array.isArray(output.tasks) ? output.tasks : [];
      if (!tasks.length) {
        // A manager that reports success without ever delegating has delivered nothing:
        // the specialists own the work, so the turn is a protocol error, not a result.
        if (!delegated && !nudged) {
          nudged = true;
          this.persistEvent(ctx.runId, 'delegation.nudge', { nodeId: node.nodeId, status: output.status }, 'warn', manager.memberId, node.nodeId);
          taskText = [
            '## No delegation was accepted',
            'You finished without emitting `tasks[]`, so nobody did any work and the objective is not delivered.',
            'Respond now with the required fenced ```json block containing at least one entry in `tasks[]`, each to a member of the roster with a self-contained brief. Do not answer `complete` before work has been delegated and reviewed.',
          ].join('\n');
          continue;
        }
        if (!delegated) {
          output = { ...output, status: 'blocked', summary: `manager completed without delegating any work: ${String(output.summary ?? '').slice(0, 400)}` };
          this.persistEvent(ctx.runId, 'delegation.missing', { nodeId: node.nodeId, status: 'blocked' }, 'warn', manager.memberId, node.nodeId);
        }
        break;
      }
      if (round === maxRounds) {
        this.persistEvent(ctx.runId, 'delegation.limit', { nodeId: node.nodeId, maxDepth: maxRounds }, 'warn', managerIdOf(ctx), node.nodeId);
        break;
      }
      const allowed = this.allowedDelegates(ctx, manager);
      const accepted: { memberId: string; title: string; task: string; id: string }[] = [];
      for (const t of tasks) {
        const target = String(t.memberId ?? '').trim();
        const title = String(t.title ?? target);
        if (!ctx.members.has(target)) {
          this.persistEvent(ctx.runId, 'delegation.rejected', { nodeId: node.nodeId, memberId: target, reason: 'unknown member' }, 'warn', manager.memberId, node.nodeId);
          continue;
        }
        if (allowed && !allowed.has(target)) {
          this.persistEvent(ctx.runId, 'delegation.rejected', { nodeId: node.nodeId, memberId: target, reason: 'not an allowed delegate' }, 'warn', manager.memberId, node.nodeId);
          continue;
        }
        accepted.push({ memberId: target, title, task: String(t.task ?? t.title ?? ''), id: String(t.id ?? `${node.nodeId}-r${round}-${accepted.length + 1}`) });
      }
      if (!accepted.length) {
        this.persistEvent(ctx.runId, 'delegation.none', { nodeId: node.nodeId, round, requested: tasks.length }, 'warn', manager.memberId, node.nodeId);
        if (round < maxRounds) {
          taskText = [
            '## No delegation was accepted',
            tasks.map((t) => `- \`${String(t.memberId)}\` — ${String(t.title ?? '')}: rejected (not a permitted delegate)`).join('\n'),
            '',
            'Complete the remaining work yourself, or delegate only to members your delegation policy allows. Answer with status `complete` when the objective is met.',
          ].join('\n');
          continue;
        }
        break;
      }

      delegated += accepted.length;
      this.persistEvent(ctx.runId, 'delegation.batch', { nodeId: node.nodeId, round, tasks: accepted.map((t) => ({ memberId: t.memberId, title: t.title })) }, 'info', manager.memberId, node.nodeId);
      const results = await this.mapLimit(accepted, maxParallel, async (t) => {
        const target = ctx.members.get(t.memberId)!;
        this.opts.store.addMessage({
          systemRunId: ctx.runId, from: manager.memberId, to: [t.memberId], type: 'task-request',
          body: `**${t.title}**\n\n${this.capBody(t.task, 500)}`, nodeId: node.nodeId,
        });
        return this.runTurn(ctx, node, target, { task: `${t.title}\n\n${t.task}`, control, delegated: true });
      });

      const reviewLines = results.map((r, i) => {
        const t = accepted[i];
        return `- ${t.memberId} (${ctx.members.get(t.memberId)?.role ?? t.memberId}) — ${t.title}: **${r.output.status}** — ${String(r.output.summary ?? '').slice(0, 500)}`;
      });
      taskText = [
        `## Delegated work results (round ${round + 1})`,
        ...reviewLines,
        '',
        'Review these results. If work is missing, incorrect, or needs another specialist, delegate follow-up tasks in `tasks`. If the objective is met, answer with status `complete` and no tasks.',
        allowDynamic ? 'You may also request additional specialists in `addMembers` when the objective genuinely needs expertise the team does not have.' : '',
      ].filter(Boolean).join('\n');
      output = { ...output, status: 'in-progress' };
    }

    const nodeRunId = lastRunId ?? this.opts.store.startNodeRun({ systemRunId: ctx.runId, nodeId: node.nodeId, memberId: manager.memberId, attempt: 1, iteration: 1 });
    // Running out of delegation rounds is not a delivery: the manager never declared the
    // objective met, so reporting the node green would be a false pass.
    if (!SUCCESS_STATUSES.has(String(output.status))) {
      output = { ...output, status: 'blocked', summary: `manager did not declare completion within ${maxRounds + 1} round(s): ${String(output.summary ?? '').slice(0, 300)}` };
      this.persistEvent(ctx.runId, 'delegation.exhausted', { nodeId: node.nodeId, rounds: maxRounds + 1, delegated }, 'warn', manager.memberId, node.nodeId);
    }
    const nodeStatus: NodeRunResult['status'] = ['failed', 'blocked'].includes(String(output.status)) ? 'blocked' : 'done';
    this.persistEvent(ctx.runId, 'node.end', { nodeId: node.nodeId, status: output.status, summary: output.summary, delegated, ms: undefined }, nodeStatus === 'done' ? 'info' : 'warn', manager.memberId, node.nodeId);
    return { nodeId: node.nodeId, memberId: manager.memberId, status: nodeStatus, output, runId: nodeRunId, attempts: 1 };
  }

  private allowedDelegates(ctx: RunContext, manager: MemberContext): Set<string> | undefined {
    const policy = manager.declaration?.delegation;
    if (!policy || policy.enabled === false) return undefined;
    if (!policy.allowedMemberIds?.length) return undefined;
    return new Set(policy.allowedMemberIds);
  }

  /** Run-scoped dynamic composition: never mutates the published team definition. */
  private async applyRequestedMembers(ctx: RunContext, node: WorkflowNode, manager: MemberContext, output: NodeOutput, control: Control): Promise<void> {
    const requested = Array.isArray((output as { addMembers?: unknown }).addMembers)
      ? ((output as { addMembers?: unknown[] }).addMembers ?? [])
      : [];
    if (!requested.length) return;
    if (manager.declaration?.delegation?.enabled === false) {
      this.persistEvent(ctx.runId, 'member.add_rejected', { reason: 'manager delegation is disabled', count: requested.length }, 'warn', manager.memberId, node.nodeId);
      return;
    }
    const added: ResolvedMember[] = [...(ctx.snapshot.addedMembers ?? [])];
    for (const raw of requested) {
      const spec = raw as { memberId?: unknown; role?: unknown; agentRef?: { agentId?: unknown; version?: unknown; definitionHash?: unknown } };
      const memberId = String(spec.memberId ?? '').trim();
      const agentId = String(spec.agentRef?.agentId ?? '').trim();
      if (!memberId || !agentId) continue;
      if (ctx.members.has(memberId)) continue;
      const resolved = resolveAgentRef({ agentId, version: spec.agentRef?.version ? String(spec.agentRef.version) : undefined, definitionHash: spec.agentRef?.definitionHash ? String(spec.agentRef.definitionHash) : undefined }, this.opts.lookup);
      if (!resolved.ok) {
        this.persistEvent(ctx.runId, 'member.add_rejected', { memberId, reason: resolved.error }, 'warn', manager.memberId, node.nodeId);
        continue;
      }
      const entry: ResolvedMember = {
        memberId, role: String(spec.role ?? memberId), agentId: resolved.value.agentId,
        agentVersion: resolved.value.version, definitionHash: resolved.value.definitionHash, definitionJson: resolved.value.definitionJson,
      };
      added.push(entry);
      const ctxMember = await this.memberContext(ctx.runId, entry, ctx.system, ctx.runWorkspace);
      ctx.members.set(memberId, ctxMember);
      this.opts.store.upsertRunSession({ systemRunId: ctx.runId, memberId, sessionId: ctxMember.sessionId, agentId: ctxMember.agentId, workspace: ctxMember.workspace });
      this.persistEvent(ctx.runId, 'member.added', { memberId, role: entry.role, agentId: entry.agentId, version: entry.agentVersion, requestedBy: manager.memberId }, 'info', memberId, node.nodeId);
      if (control.abort.signal.aborted) return;
    }
    const previously = ctx.snapshot.addedMembers ?? [];
    if (added.length !== previously.length) {
      ctx.snapshot.addedMembers = added;
      this.opts.store.setRunSnapshot(ctx.runId, JSON.stringify(ctx.snapshot));
      const fresh = added.filter((a) => !previously.some((p) => p.memberId === a.memberId)).map((a) => a.memberId);
      this.opts.store.addMessage({
        systemRunId: ctx.runId, from: manager.memberId, to: [manager.memberId], type: 'decision',
        body: `Run-scoped team change: added ${fresh.join(', ') || 'no new members'}. The published team definition is unchanged.`,
        nodeId: node.nodeId,
      });
    }
  }

  // ------------------------------------------------------------------- turns

  private async runTurn(
    ctx: RunContext,
    node: WorkflowNode,
    member: MemberContext,
    opts: { task: string; control: Control; contract?: WorkflowNode['outputContract']; managerRound?: number; delegated?: boolean },
  ): Promise<{ output: NodeOutput; nodeRunId: string; artifacts: ArtifactRow[] }> {
    return this.withLock(`${ctx.runId}:${member.memberId}`, async () => {
      const store = this.opts.store;
      const attemptBudget = Math.max(1, ctx.workflow.limits?.maxAttempts ?? ctx.limits.maxAttempts);
      let lastError: Error | undefined;
      for (let attempt = 1; attempt <= attemptBudget; attempt++) {
        if (opts.control.abort.signal.aborted) throw new ActivationError('team run stopped');
        const activation = ctx.nodeCounts.get(node.nodeId) ?? 0;
        const nodeRunId = store.startNodeRun({
          systemRunId: ctx.runId, nodeId: node.nodeId, memberId: member.memberId,
          attempt, iteration: Math.max(1, activation),
          task: `${opts.task}${opts.managerRound !== undefined ? ` (manager round ${opts.managerRound + 1})` : ''}`,
        });
        const startedAt = new Date().toISOString();
        try {
          this.progress(ctx, member, 'working', 5, 'starting', `${member.role} starting ${node.nodeId}`, node.nodeId);
          const inbox = store.undeliveredFor(ctx.runId, member.memberId);
          const brief = this.buildBrief(ctx, node, member, opts, inbox);
          const roles = new Map([...ctx.members.values()].map((m) => [m.memberId, m.role]));
          const budget = { sent: 0 };
          const tools: TeamTool[] = this.teamTools(ctx, node, member, roles, budget);
          for (const message of inbox) store.markDelivered([message.id]);

          this.progress(ctx, member, 'working', 15, 'thinking', `${member.role} is working on ${node.nodeId}`, node.nodeId);
          this.persistEvent(ctx.runId, 'turn.send', { nodeId: node.nodeId, memberId: member.memberId, attempt, chars: brief.length, inbox: inbox.length }, 'info', member.memberId, node.nodeId);
          const result = await this.opts.executor.run({
            teamRunId: ctx.runId, nodeId: node.nodeId, memberId: member.memberId, role: member.role,
            agentId: member.agentId, definitionHash: member.definitionHash, definitionSnapshot: member.portable,
            definition: member.definition, sessionId: member.sessionId, prompt: brief,
            workspaceRoot: member.workspace, approvalMode: 'strict', timeoutMs: ctx.workflow.limits?.maxDurationMs,
            tools, signal: opts.control.abort.signal,
            memory: this.opts.memoryFor?.({ definition: member.definition, memberId: member.memberId, agentId: member.agentId, task: opts.task, runId: ctx.runId }),
            onEvent: (type, payload) => this.persistEvent(ctx.runId, `member.${type}`, payload, type.includes('error') ? 'warn' : 'info', member.memberId, node.nodeId),
          });
          if (opts.control.abort.signal.aborted) throw new ActivationError('team run stopped');

          const output = parseNodeOutput(result.text);
          const activationArtifacts = this.collectActivationArtifacts(ctx, member, node.nodeId, startedAt);
          const published = this.publishOutputArtifacts(ctx, node, member, output);
          const allArtifacts = [...activationArtifacts, ...published];

          const verbosity = ctx.policy.verbosity ?? 'concise';
          const maxMessages = Math.max(0, ctx.policy.maxMessagesPerTurn ?? 2);
          const maxChars = Math.max(120, ctx.policy.maxBodyChars ?? 600);
          const sentBodies = new Set<string>();
          for (const reply of output.replies ?? []) {
            if (verbosity !== 'normal' && reply.type === 'status-update') {
              this.persistEvent(ctx.runId, 'message.rejected', { from: member.memberId, reason: 'status updates belong on the progress board, not in chat' }, 'info', member.memberId, node.nodeId);
              continue;
            }
            if (budget.sent >= maxMessages) {
              this.persistEvent(ctx.runId, 'message.rejected', { from: member.memberId, reason: `message budget reached (${maxMessages}/turn)` }, 'warn', member.memberId, node.nodeId);
              break;
            }
            const targets = deserializeMessageTargets(reply.to);
            if (!targets.length) continue;
            const body = this.capBody(String(reply.body ?? ''), maxChars);
            if (!body.trim() || sentBodies.has(body)) continue;
            const unknown = targets.filter((t) => !ctx.members.has(t));
            if (unknown.length) { this.persistEvent(ctx.runId, 'message.rejected', { to: targets, reason: `unknown members ${unknown.join(', ')}` }, 'warn', member.memberId, node.nodeId); continue; }
            const gate = messagingAllowed({ memberId: member.memberId, managerId: managerIdOf(ctx), policy: ctx.policy }, targets);
            if (!gate.ok) { this.persistEvent(ctx.runId, 'message.rejected', { to: targets, reason: gate.reason }, 'warn', member.memberId, node.nodeId); continue; }
            sentBodies.add(body);
            budget.sent++;
            const messageId = store.addMessage({
              systemRunId: ctx.runId, from: member.memberId, to: targets, type: reply.type ?? 'message',
              body, nodeId: node.nodeId,
              artifactIds: allArtifacts.map((a) => a.id),
            });
            this.persistEvent(ctx.runId, 'message.sent', { messageId, from: member.memberId, to: targets, type: reply.type ?? 'message' }, 'info', member.memberId, node.nodeId);
          }

          let status = output.status;
          let contractError: string | undefined;
          if (opts.contract?.artifactTypes?.length) {
            const missing = opts.contract.artifactTypes.filter((t) => !allArtifacts.some((a) => a.type === t));
            if (missing.length && opts.contract.required !== false) {
              status = 'blocked';
              contractError = `output contract not met: missing artifact type(s) ${missing.join(', ')}`;
              this.persistEvent(ctx.runId, 'contract.missing', { nodeId: node.nodeId, memberId: member.memberId, missing }, 'warn', member.memberId, node.nodeId);
            }
          }
          const finalOutput: NodeOutput = { ...output, status, summary: contractError ? `${output.summary ?? ''} ${contractError}`.trim() : output.summary, artifacts: allArtifacts.map((a) => ({ id: a.id, type: a.type, name: a.name })) };
          const succeeded = ['done', 'completed', 'complete', 'passed', 'accepted', 'approved'].includes(String(status));
          const failed = status === 'failed' || status === 'blocked';
          this.progress(ctx, member, failed ? 'blocked' : succeeded ? 'done' : 'working',
            failed ? 100 : succeeded ? 100 : 90,
            failed ? 'blocked' : succeeded ? 'finished' : String(status),
            String(finalOutput.summary ?? '').slice(0, 300), node.nodeId);
          this.resolveHandoffs(ctx, member, node, status, finalOutput.summary);
          store.finishNodeRun(nodeRunId, contractError ? 'blocked' : 'done', { runId: result.runId, outputJson: JSON.stringify(finalOutput).slice(0, 100_000), error: contractError });
          this.persistEvent(ctx.runId, 'turn.end', {
            nodeId: node.nodeId, memberId: member.memberId, status, runId: result.runId,
            tools: result.tools.map((t) => t.name).slice(0, 25), tokensIn: result.tokensIn, tokensOut: result.tokensOut,
            summary: String(finalOutput.summary ?? '').slice(0, 600),
          }, status === 'failed' || status === 'blocked' ? 'warn' : 'info', member.memberId, node.nodeId);
          return { output: finalOutput, nodeRunId, artifacts: allArtifacts };
        } catch (err) {
          lastError = err as Error;
          if (opts.control.abort.signal.aborted) {
            store.finishNodeRun(nodeRunId, 'aborted', { error: 'team run stopped' });
            throw new ActivationError('team run stopped');
          }
          store.finishNodeRun(nodeRunId, 'failed', { error: lastError.message });
          this.progress(ctx, member, 'failed', 100, 'failed', lastError.message.slice(0, 300), node.nodeId);
          this.persistEvent(ctx.runId, 'turn.error', { nodeId: node.nodeId, memberId: member.memberId, attempt, error: lastError.message }, 'error', member.memberId, node.nodeId);
          if (attempt < attemptBudget) {
            const wait = Math.round(ctx.limits.backoffMs * Math.pow(ctx.limits.retryBackoffMultiplier, attempt - 1));
            await sleep(wait, opts.control.abort.signal);
          }
        }
      }
      throw new ActivationError(`${member.memberId} failed after ${attemptBudget} attempt(s): ${lastError?.message ?? 'unknown error'}`);
    });
  }

  private collectActivationArtifacts(ctx: RunContext, member: MemberContext, nodeId: string, startedAt: string): ArtifactRow[] {
    return this.opts.store.listArtifacts(ctx.runId, { memberId: member.memberId })
      .filter((a) => a.node_id === nodeId && (!a.created_at || a.created_at >= startedAt));
  }

  private publishOutputArtifacts(ctx: RunContext, node: WorkflowNode, member: MemberContext, output: NodeOutput): ArtifactRow[] {
    const rows: ArtifactRow[] = [];
    for (const artifact of output.artifacts ?? []) {
      if (!artifact || typeof artifact !== 'object') continue;
      try {
        rows.push(publishArtifact(
          { store: this.opts.store, systemRunId: ctx.runId, memberId: member.memberId, artifactsDir: ctx.artifactsDir, nodeId: node.nodeId, emit: (k, p) => this.persistEvent(ctx.runId, k, p, 'info', member.memberId, node.nodeId) },
          { type: String(artifact.type ?? 'document'), name: String(artifact.name ?? 'artifact.txt'), content: typeof artifact.content === 'string' ? artifact.content : undefined, memberWorkspace: member.workspace },
        ));
      } catch (err) {
        this.persistEvent(ctx.runId, 'artifact.error', { nodeId: node.nodeId, name: artifact.name, error: (err as Error).message }, 'warn', member.memberId, node.nodeId);
      }
    }
    return rows;
  }

  private buildBrief(
    ctx: RunContext,
    node: WorkflowNode,
    member: MemberContext,
    opts: { task: string; managerRound?: number; delegated?: boolean },
    inbox: ReturnType<TeamStore['undeliveredFor']>,
  ): string {
    const roles = new Map([...ctx.members.values()].map((m) => [m.memberId, m.role]));
    const isManager = node.type === 'manager';
    const roster = [...ctx.members.values()].map((m) => {
      const stamp = m.memberId === managerIdOf(ctx) ? ' — manager' : '';
      const line = `- \`${m.memberId}\` — ${m.role}${stamp}`;
      const add = m.declaration?.instructions?.trim();
      return add ? `${line}\n  ${add.replace(/\s+/g, ' ').slice(0, 300)}` : line;
    });
    const artifacts = this.opts.store.listArtifacts(ctx.runId);
    const artifactLines = artifacts.slice(0, 40).map((a) => `- [${a.id}] ${a.type} · ${a.name} v${a.version} — ${a.member_id} — \`${a.path ?? ''}\``);
    const contract = node.outputContract?.artifactTypes?.length
      ? `\n## Required deliverables\nPublish at least one artifact of each type before finishing: ${node.outputContract.artifactTypes.map((t) => `\`${t}\``).join(', ')}. Use team_publish_artifact or the artifacts[] field.`
      : '';
    const delegation = isManager && node.type === 'manager'
      ? [
        '\n## Manager duties',
        'You own coordination, not all of the work. Read the task, then split it into clear workstreams and delegate each to the right member with `tasks[]`.',
        'Each task: `{ "memberId": "...", "title": "...", "task": "precise brief and expected output" }`. Independent tasks run in parallel; one member\'s tasks run sequentially.',
        ctx.workflow.manager?.allowDynamicTaskCreation !== false
          ? 'If the objective needs expertise the team does not have, request specialists with `addMembers[]` (`{ "memberId", "role", "agentRef": { "agentId", "version?" } }`) — they join this run only. The registry is the source of truth; never invent business details for them.'
          : '',
        'After delegated work you will be asked to review it. Do not claim completion while a required deliverable is missing.',
      ].filter(Boolean).join('\n')
      : '';
    const roundNote = opts.managerRound ? `\nThis is review round ${opts.managerRound + 1} of delegated work.` : '';
    const inboxBlock = renderInbox(inbox, member.memberId, roles);

    return [
      `# Team run — ${ctx.snapshot.systemName} · ${ctx.workflow.name} (${ctx.workflow.mode})`,
      `You are **${member.role}**, member \`${member.memberId}\`, working as an independent agent (${member.agentId}@${ctx.snapshot.resolvedMembers.find((m) => m.memberId === member.memberId)?.agentVersion ?? 'pinned'}).`,
      '',
      '## Team objective',
      ctx.snapshot.task,
      '',
      `## Your assignment${opts.delegated ? ' (delegated by the manager)' : ''}`,
      opts.task,
      member.declaration?.instructions?.trim() ? `\nStanding instructions: ${member.declaration.instructions.trim()}` : '',
      roundNote,
      contract,
      delegation,
      '',
      '## Team roster',
      ...roster,
      '',
      '## Shared deliverables so far',
      artifactLines.length ? artifactLines.join('\n') : '- (none yet)',
      'Read any of them with `team_read_artifact`; build on them instead of re-deriving work.',
      '',
      '## Workspace',
      `Your workspace: \`${member.workspace}\` (shared deliverables: \`${ctx.artifactsDir}\`). Work only in your workspace and the shared artifact folder.`,
      '',
      '## Communication discipline',
      `Progress is reported on the board (team_report_progress / \`progress\`), not in chat. You may send at most ${Math.max(0, ctx.policy.maxMessagesPerTurn ?? 2)} short message(s) this turn, each under ${Math.max(120, ctx.policy.maxBodyChars ?? 600)} characters.`, 
      'Message another member only when they must act: a handoff, a blocker, a review request, a decision, or an escalation. No greetings, no acknowledgements, no restating your summary.',
      '',
      inboxBlock,
      '',
      OUTPUT_CONTRACT_PROMPT,
    ].filter((line) => line !== '').join('\n');
  }

  private teamTools(ctx: RunContext, node: WorkflowNode, member: MemberContext, roles: Map<string, string>, budget?: { sent: number }): TeamTool[] {
    return buildTeamTools({
      store: this.opts.store, systemRunId: ctx.runId, memberId: member.memberId, roles,
      managerId: managerIdOf(ctx), runWorkspace: ctx.runWorkspace, memberWorkspace: member.workspace,
      nodeId: node.nodeId, policy: ctx.policy, budget,
      emit: (kind, payload) => this.persistEvent(ctx.runId, kind, payload, 'info', member.memberId, node.nodeId),
    });
  }

  /** Structured progress lives beside the transcript, never inside it. */
  private progress(ctx: RunContext, member: MemberContext, status: string, percent: number, phase: string, summary: string, nodeId?: string): void {
    try {
      this.opts.store.upsertMemberProgress({
        systemRunId: ctx.runId, memberId: member.memberId, status, percent, phase,
        summary: summary.replace(/\s+/g, ' ').trim().slice(0, 300),
      });
      this.persistEvent(ctx.runId, 'progress.updated', { memberId: member.memberId, status, percent, phase, summary: summary.slice(0, 300) }, status === 'failed' ? 'warn' : 'info', member.memberId, nodeId);
    } catch { /* progress must never fail a run */ }
  }

  private capBody(body: string, max: number): string {
    const clean = body.replace(/\r\n/g, '\n').trim();
    return clean.length > max ? `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}…` : clean;
  }

  // ----------------------------------------------------------------- handoffs

  private recordHandoff(ctx: RunContext, result: NodeRunResult, toNodeId: string, target: WorkflowNode): void {
    if (!result.memberId || !target.memberId || target.type === 'terminal' || target.type === 'join') return;
    const artifactIds = (result.output.artifacts ?? []).map((a) => String((a as { id?: string }).id ?? '')).filter(Boolean);
    const handoffId = this.opts.store.addHandoff({
      systemRunId: ctx.runId, from: result.memberId, to: target.memberId, taskId: toNodeId,
      status: 'pending', artifactIds, summary: String(result.output.summary ?? '').slice(0, 2000),
    });
    this.persistEvent(ctx.runId, 'handoff.created', { handoffId, from: result.memberId, to: target.memberId, nodeId: toNodeId, artifacts: artifactIds.length }, 'info', result.memberId, result.nodeId);
    // Sequential work is a real relay: the next specialist must see who handed off
    // what, not just a ledger row. One terse message per transition is the entire
    // chat cost of a linear workflow.
    if (ctx.policy.enabled !== false && ctx.policy.persistMessages !== false && ctx.policy.allowPeerToPeer !== false && ctx.workflow.mode === 'sequential') {
      const names = (result.output.artifacts ?? [])
        .map((a) => `${String((a as { name?: string }).name ?? 'artifact')} (${String((a as { id?: string }).id ?? '')})`)
        .slice(0, 4).join(', ');
      const body = this.capBody(
        `Handoff from ${result.memberId}: ${String(result.output.summary ?? 'work complete').slice(0, 400)}${names ? `\nArtifacts: ${names}` : ''}`,
        ctx.policy.maxBodyChars ?? 600,
      );
      const messageId = this.opts.store.addMessage({
        systemRunId: ctx.runId, from: result.memberId, to: [target.memberId], type: 'handoff', body, nodeId: toNodeId,
        artifactIds,
      });
      this.persistEvent(ctx.runId, 'message.sent', { messageId, from: result.memberId, to: [target.memberId], type: 'handoff', automatic: true }, 'info', result.memberId, result.nodeId);
    }
  }

  private resolveHandoffs(ctx: RunContext, member: MemberContext, node: WorkflowNode, status: string, summary?: string): void {
    const open = this.opts.store.listHandoffs(ctx.runId).filter((h) => h.to_member === member.memberId && h.status === 'pending');
    if (!open.length) return;
    const rejected = ['changes-requested', 'rejected', 'failed', 'blocked'].includes(status);
    for (const handoff of open) {
      this.opts.store.decideHandoff(handoff.id, rejected ? 'rejected' : 'accepted', rejected ? (summary ?? status) : undefined);
      this.persistEvent(ctx.runId, 'handoff.decided', { handoffId: handoff.id, from: handoff.from_member, to: handoff.to_member, decision: rejected ? 'rejected' : 'accepted', status }, rejected ? 'warn' : 'info', member.memberId, node.nodeId);
      if (ctx.policy.enabled !== false && rejected) {
        this.opts.store.addMessage({
          systemRunId: ctx.runId, from: member.memberId, to: [handoff.from_member], type: 'review-response',
          body: `Handoff rejected (${status}). ${summary ?? ''}`.trim(), nodeId: node.nodeId,
        });
      }
    }
  }

  // ------------------------------------------------------------------ helpers

  private persistEvent(runId: string, kind: string, payload: Record<string, unknown>, level: 'info' | 'warn' | 'error' = 'info', memberId?: string, nodeId?: string): void {
    try {
      const ev = this.opts.store.appendEvent({ systemRunId: runId, kind, payload, level, memberId, nodeId });
      this.opts.onEvent?.(runId, ev);
    } catch { /* audit must never break execution */ }
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    this.locks.set(key, prev.then(() => gate, () => gate));
    await prev.catch(() => undefined);
    try { return await fn(); } finally { release(); }
  }

  private async mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length) as R[];
    let cursor = 0;
    const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    });
    await Promise.all(workers);
    return out;
  }
}

function managerIdOf(ctx: RunContext): string | undefined {
  return ctx.workflow.manager?.memberId ?? ctx.workflow.nodes.find((n) => n.type === 'manager')?.memberId;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    const timer = setTimeout(resolvePromise, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolvePromise(); }, { once: true });
  });
}

/** Read artifact ids from a node output that carries them inline. */
export function outputArtifactIds(output: NodeOutput): string[] {
  return (output.artifacts ?? []).map((a) => String((a as { id?: string }).id ?? '')).filter(Boolean);
}
