import { hydrateAgentDefinition } from '../agents/loader.js';
import type { AgentDefinition } from '../core/types.js';
import type { ResolvedAgentRef } from './validate.js';
import type { AgentRef, AgentSystemDefinition, ResolvedMember, TeamMember } from './types.js';
import type { AgentSystemDefinition as SystemDef } from './types.js';

/**
 * The narrow slice of storage the resolver needs. Keeping it structural lets the
 * API pass the SQLite store while tests pass an in-memory map.
 */
export interface AgentLookup {
  getAgent(id: string): { id: string; name: string; version: string; definition_json: string; definition_hash?: string | null } | undefined;
  listAgents(status?: string): { id: string; name: string; version: string }[];
  /** A historical definition body for (agentId, hash), if the version history recorded it. */
  findDefinitionVersion?(agentId: string, hash: string): { definition_json: string; definition_hash: string; version: string } | undefined;
}

export interface MemberResolution {
  ok: boolean;
  error?: string;
  /** True when the pin had to be relaxed (no version/hash supplied) — reported as a warning. */
  unpinned?: boolean;
  member?: ResolvedMember;
}

/** Resolve one `agentRef` to an exact stored definition. */
export function resolveAgentRef(ref: AgentRef, lookup: AgentLookup): { ok: true; value: ResolvedAgentRef & { definitionJson: string } } | { ok: false; error: string } {
  const raw = String(ref.agentId ?? '').trim();
  if (!raw) return { ok: false, error: 'agentRef.agentId is required' };
  const row = findAgentRow(raw, ref.version, lookup);
  if (!row) return { ok: false, error: `agent '${raw}'${ref.version ? ` version ${ref.version}` : ''} is not registered` };

  const currentHash = row.definition_hash?.trim();
  if (ref.version && row.version !== ref.version) {
    return { ok: false, error: `agent '${row.id}' is version ${row.version}, but the team pins ${ref.version}` };
  }

  if (ref.definitionHash) {
    if (currentHash && hashesEqual(currentHash, ref.definitionHash)) {
      return { ok: true, value: { agentId: row.id, version: row.version, definitionHash: currentHash, definitionJson: row.definition_json } };
    }
    const historical = lookup.findDefinitionVersion?.(row.id, ref.definitionHash);
    if (historical) {
      return { ok: true, value: { agentId: row.id, version: historical.version, definitionHash: historical.definition_hash, definitionJson: historical.definition_json } };
    }
    return {
      ok: false,
      error: currentHash
        ? `definition drift: team pins ${ref.definitionHash} but ${row.id} now hashes to ${currentHash} and no stored version matches the pin`
        : `${row.id} has no recorded definition hash; the team pin ${ref.definitionHash} cannot be verified`,
    };
  }
  return { ok: true, value: { agentId: row.id, version: row.version, definitionHash: currentHash ?? '', definitionJson: row.definition_json } };
}

function findAgentRow(raw: string, version: string | undefined, lookup: AgentLookup) {
  const direct = lookup.getAgent(raw);
  if (direct) return direct;
  if (!raw.includes('@') && version) {
    const withVersion = lookup.getAgent(`${raw}@${version}`);
    if (withVersion) return withVersion;
  }
  // Fall back to a name match, newest first (listAgents is created_at DESC for 'all').
  const rows = lookup.listAgents('all').filter((a) => a.name === raw || a.id.startsWith(`${raw}@`));
  if (!rows.length) return undefined;
  const match = version ? rows.find((r) => r.version === version) : rows[0];
  return match ? lookup.getAgent(match.id) : undefined;
}

/** Resolve every member of a team, collecting per-member errors. */
export function resolveTeamMembers(definition: AgentSystemDefinition, lookup: AgentLookup): { members: ResolvedMember[]; errors: string[]; warnings: string[] } {
  const members: ResolvedMember[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const m of definition.team.members) {
    const r = resolveAgentRef(m.agentRef, lookup);
    if (!r.ok) { errors.push(`member '${m.memberId}': ${r.error}`); continue; }
    if (!m.agentRef.definitionHash) warnings.push(`member '${m.memberId}' is not hash-pinned (resolved ${r.value.definitionHash || 'unknown hash'})`);
    members.push({
      memberId: m.memberId,
      role: m.role,
      agentId: r.value.agentId,
      agentVersion: r.value.version,
      definitionHash: r.value.definitionHash,
      definitionJson: r.value.definitionJson,
    });
  }
  return { members, errors, warnings };
}

/** Hydrate a member's portable definition into the run-ready (env-expanded) form. */
export function hydrateMember(member: ResolvedMember): { definition: AgentDefinition; portable: string; hash: string } {
  const load = hydrateAgentDefinition(member.definitionJson);
  return { definition: load.resolved, portable: member.definitionJson, hash: member.definitionHash || load.definitionHash };
}

/** Validation adapter: the team validator only needs existence + hash agreement. */
export function resolverFor(lookup: AgentLookup): (ref: AgentRef) => { ok: true; value: ResolvedAgentRef } | { ok: false; error: string } {
  return (ref) => {
    const r = resolveAgentRef(ref, lookup);
    return r.ok ? { ok: true, value: { agentId: r.value.agentId, version: r.value.version, definitionHash: r.value.definitionHash } } : r;
  };
}

export function hashesEqual(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().toLowerCase().replace(/^sha256:/, '');
  const x = norm(a);
  const y = norm(b);
  return x === y || (x.length >= 8 && y.length >= 8 && (x.startsWith(y) || y.startsWith(x)));
}

/** Find a member's declaration (role, delegation, instructions) by id. */
export function memberOf(system: SystemDef, memberId: string): TeamMember | undefined {
  return system.team.members.find((m) => m.memberId === memberId);
}
