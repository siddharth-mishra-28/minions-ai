import type { AgentRef, AgentSystemDefinition, TeamMember, WorkflowDefinition, WorkflowNode } from './types.js';

/**
 * Semantic validation for a team definition. Structural rules are pure; agent
 * references are checked through `resolveAgent` so the same validator serves the
 * API (with a DB-backed resolver) and unit tests (with a stub).
 *
 * Publishing and starting a run both run this. Publishing refuses on errors;
 * a run refuses too, because a pinned hash that no longer resolves must never
 * silently execute a different agent.
 */
export interface ResolvedAgentRef {
  agentId: string;
  version: string;
  definitionHash: string;
}

export interface ValidationContext {
  /** Resolve an agent reference against the definition registry. */
  resolveAgent?: (ref: AgentRef) => { ok: true; value: ResolvedAgentRef } | { ok: false; error: string };
}

export interface ValidationReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

const AGENT_NODE_TYPES = new Set(['agent-task', 'manager', 'human-approval']);

export function validateTeam(definition: AgentSystemDefinition, ctx: ValidationContext = {}): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const members = new Map<string, TeamMember>();
  for (const m of definition.team.members) {
    if (members.has(m.memberId)) errors.push(`duplicate memberId '${m.memberId}'`);
    members.set(m.memberId, m);
  }

  // ---- hierarchy -----------------------------------------------------------
  for (const m of definition.team.members) {
    if (m.reportsTo && !members.has(m.reportsTo)) {
      errors.push(`member '${m.memberId}' reportsTo unknown member '${m.reportsTo}'`);
    }
    if (m.reportsTo === m.memberId) errors.push(`member '${m.memberId}' cannot report to itself`);
    for (const allowed of m.delegation?.allowedMemberIds ?? []) {
      if (!members.has(allowed)) errors.push(`member '${m.memberId}' may delegate to unknown member '${allowed}'`);
    }
  }
  const cycle = findReportingCycle(definition.team.members);
  if (cycle) errors.push(`circular reporting relationship: ${cycle.join(' → ')}`);
  const roots = definition.team.members.filter((m) => !m.reportsTo);
  if (roots.length > 1) {
    warnings.push(`${roots.length} members have no manager (${roots.map((r) => r.memberId).join(', ')}); that is normal for peer teams, but hierarchical workflows need one root manager`);
  }

  // ---- agent references ----------------------------------------------------
  if (ctx.resolveAgent) {
    const seen = new Set<string>();
    for (const m of definition.team.members) {
      const r = ctx.resolveAgent(m.agentRef);
      if (!r.ok) errors.push(`member '${m.memberId}': ${r.error}`);
      else {
        const key = `${m.memberId}:${r.value.definitionHash}`;
        if (seen.has(key)) warnings.push(`member '${m.memberId}' resolves the same agent definition twice`);
        seen.add(key);
        if (m.agentRef.definitionHash && !sameHash(m.agentRef.definitionHash, r.value.definitionHash)) {
          errors.push(`member '${m.memberId}' pins hash ${m.agentRef.definitionHash} but ${r.value.agentId} resolves to ${r.value.definitionHash}`);
        }
      }
    }
  }

  // ---- workflows -----------------------------------------------------------
  const ids = new Set<string>();
  for (const w of definition.orchestration.workflows) {
    if (ids.has(w.workflowId)) errors.push(`duplicate workflowId '${w.workflowId}'`);
    ids.add(w.workflowId);
    validateWorkflow(w, members, errors, warnings);
  }
  if (!ids.has(definition.orchestration.defaultWorkflowId)) {
    errors.push(`defaultWorkflowId '${definition.orchestration.defaultWorkflowId}' is not declared`);
  }

  // ---- communication -------------------------------------------------------
  const comms = definition.orchestration.communication;
  if (comms?.allowPeerToPeer === false) {
    const hasManager = definition.orchestration.workflows.some((w) => w.manager);
    if (!hasManager) warnings.push('peer-to-peer messaging is disabled but no workflow declares a manager — agents will not be able to ask anyone anything');
  }

  return { ok: errors.length === 0, errors, warnings };
}

function validateWorkflow(w: WorkflowDefinition, members: Map<string, TeamMember>, errors: string[], warnings: string[]): void {
  const nodes = new Map<string, WorkflowNode>();
  for (const n of w.nodes) {
    if (nodes.has(n.nodeId)) errors.push(`[${w.workflowId}] duplicate nodeId '${n.nodeId}'`);
    nodes.set(n.nodeId, n);
  }
  if (!nodes.has(w.entryNodeId)) errors.push(`[${w.workflowId}] entryNodeId '${w.entryNodeId}' is not a node`);

  for (const n of w.nodes) {
    if (AGENT_NODE_TYPES.has(n.type)) {
      if (!n.memberId) errors.push(`[${w.workflowId}] node '${n.nodeId}' (${n.type}) requires memberId`);
      else if (!members.has(n.memberId)) errors.push(`[${w.workflowId}] node '${n.nodeId}' references unknown member '${n.memberId}'`);
    }
    if (n.type === 'terminal' && n.memberId) warnings.push(`[${w.workflowId}] terminal node '${n.nodeId}' ignores memberId`);
    if (n.type === 'manager' && w.mode !== 'hierarchical' && w.mode !== 'hybrid') {
      errors.push(`[${w.workflowId}] manager node '${n.nodeId}' requires mode hierarchical or hybrid (got ${w.mode})`);
    }
  }

  for (const e of w.edges) {
    if (!nodes.has(e.from)) errors.push(`[${w.workflowId}] edge '${e.from} → ${e.to}' starts at an unknown node`);
    if (!nodes.has(e.to)) errors.push(`[${w.workflowId}] edge '${e.from} → ${e.to}' points at an unknown node`);
    if (e.from === e.to) errors.push(`[${w.workflowId}] edge '${e.from}' cannot point at itself`);
  }

  // Reachability + dead ends.
  const outgoing = new Map<string, string[]>();
  for (const e of w.edges) outgoing.set(e.from, [...(outgoing.get(e.from) ?? []), e.to]);
  const reachable = new Set<string>();
  const stack = [w.entryNodeId];
  while (stack.length) {
    const id = stack.pop()!;
    if (reachable.has(id) || !nodes.has(id)) continue;
    reachable.add(id);
    for (const to of outgoing.get(id) ?? []) stack.push(to);
  }
  for (const id of reachable) {
    const node = nodes.get(id)!;
    if (node.type !== 'terminal' && !(outgoing.get(id) ?? []).length) {
      errors.push(`[${w.workflowId}] node '${id}' has no outgoing edge and is not terminal (dead end)`);
    }
  }
  if (![...reachable].some((id) => nodes.get(id)?.type === 'terminal')) {
    errors.push(`[${w.workflowId}] no terminal node is reachable from entry '${w.entryNodeId}'`);
  }
  const unreachable = [...nodes.keys()].filter((id) => !reachable.has(id));
  if (unreachable.length) warnings.push(`[${w.workflowId}] unreachable nodes: ${unreachable.join(', ')}`);

  // Cycles are the rework mechanism, but an all-unconditional cycle is an infinite
  // loop: no result could ever break out of it. A cycle also needs an iteration
  // ceiling so a misbehaving agent cannot loop forever.
  if (hasCycle(w.edges)) {
    if (hasCycle(w.edges.filter((e) => !e.when))) {
      errors.push(`[${w.workflowId}] contains a cycle of unconditional edges — add a 'when' condition to at least one rework edge`);
    }
    if (w.limits?.maxIterations == null) {
      warnings.push(`[${w.workflowId}] has a rework cycle but no limits.maxIterations — the engine default applies`);
    }
  }
  if (w.mode === 'hierarchical' || w.mode === 'hybrid') {
    if (!w.manager) errors.push(`[${w.workflowId}] mode ${w.mode} requires a manager policy`);
    else if (!members.has(w.manager.memberId)) errors.push(`[${w.workflowId}] manager '${w.manager.memberId}' is not a team member`);
    else {
      const mgr = members.get(w.manager.memberId)!;
      if (mgr.delegation?.enabled === false && w.manager.allowDynamicTaskCreation !== false) {
        warnings.push(`[${w.workflowId}] manager '${mgr.memberId}' has delegation disabled but dynamic task creation is not off`);
      }
      if (!w.nodes.some((n) => n.type === 'manager')) warnings.push(`[${w.workflowId}] mode ${w.mode} declares a manager policy but no manager node`);
    }
  }
  // Parallel fan-out must not give one member two simultaneous tasks — the
  // scheduler serialises them, but the design is clearer when caught early.
  for (const [from, targets] of outgoing) {
    const node = nodes.get(from);
    if (!node || node.type === 'join') continue;
    const byMember = new Map<string, number>();
    for (const t of targets) {
      const m = nodes.get(t)?.memberId;
      if (m) byMember.set(m, (byMember.get(m) ?? 0) + 1);
    }
    for (const [m, count] of byMember) {
      if (count > 1) warnings.push(`[${w.workflowId}] node '${from}' fans out to member '${m}' ${count} times; their tasks will run sequentially`);
    }
  }
}

/** True when the directed graph contains a cycle (DFS colouring). */
function hasCycle(edges: { from: string; to: string }[]): boolean {
  const outgoing = new Map<string, string[]>();
  for (const e of edges) outgoing.set(e.from, [...(outgoing.get(e.from) ?? []), e.to]);
  const state = new Map<string, 'visiting' | 'done'>();
  const walk = (id: string): boolean => {
    if (state.get(id) === 'visiting') return true;
    if (state.get(id) === 'done') return false;
    state.set(id, 'visiting');
    for (const next of outgoing.get(id) ?? []) {
      if (walk(next)) return true;
    }
    state.set(id, 'done');
    return false;
  };
  for (const id of outgoing.keys()) {
    if (walk(id)) return true;
  }
  return false;
}

function findReportingCycle(members: TeamMember[]): string[] | null {
  const byId = new Map(members.map((m) => [m.memberId, m]));
  const state = new Map<string, 'visiting' | 'done'>();
  const walk = (id: string, path: string[]): string[] | null => {
    if (state.get(id) === 'visiting') return [...path.slice(path.indexOf(id)), id];
    if (state.get(id) === 'done') return null;
    state.set(id, 'visiting');
    const parent = byId.get(id)?.reportsTo;
    if (parent) {
      const found = walk(parent, [...path, id]);
      if (found) return found;
    }
    state.set(id, 'done');
    return null;
  };
  for (const m of members) {
    const found = walk(m.memberId, []);
    if (found) return found;
  }
  return null;
}

function sameHash(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().toLowerCase().replace(/^sha256:/, '');
  return norm(a) === norm(b);
}
