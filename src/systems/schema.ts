import { createHash } from 'node:crypto';
import * as AjvModule from 'ajv/dist/2020.js';
import systemSchema from '../schema/agent-system-definition-1.0.json' with { type: 'json' };
import snapshotSchema from '../schema/agent-run-snapshot-1.0.json' with { type: 'json' };
import type { AgentSystemDefinition, WorkflowDefinition } from './types.js';

type ValidateFn = ((data: unknown) => boolean) & { errors?: { instancePath: string; message?: string }[] };
type AjvInstance = {
  compile: (s: unknown) => ValidateFn;
  addSchema: (s: unknown) => unknown;
};

const AjvCtor = ((AjvModule as unknown as { default?: new (opts?: Record<string, unknown>) => AjvInstance }).default
  ?? (AjvModule as unknown as new (opts?: Record<string, unknown>) => AjvInstance));

const ajv = new AjvCtor({ strict: true, allErrors: true });
// The system schema is registered by $id so the embedded workflow definition can be
// compiled on its own (one source of truth — no duplicated node/edge schema file).
ajv.addSchema(systemSchema);
const validateSystem = ajv.compile(systemSchema) as ValidateFn;
const validateSnapshot = ajv.compile(snapshotSchema) as ValidateFn;
const workflowRef = `${(systemSchema as { $id: string }).$id}#/$defs/workflow`;
const validateWorkflow = ajv.compile({ $ref: workflowRef }) as ValidateFn;

/** Deterministic JSON: object keys sorted, so a hash survives store → read → hash round-trips. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** Stable content hash: `sha256:<16 hex>` (same shape the docs use for pinned refs). */
export function hashDefinition(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, 16)}`;
}

/** Compare hashes written with or without the `sha256:` prefix, in any case. */
export function hashMatches(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const norm = (s: string) => s.trim().toLowerCase().replace(/^sha256:/, '');
  return norm(a) === norm(b) || norm(a).startsWith(norm(b)) || norm(b).startsWith(norm(a));
}

function formatErrors(errors: { instancePath: string; message?: string }[] | undefined): string {
  return (errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`).join('; ');
}

export interface ValidatedTeam<T> {
  definition: T;
  definitionHash: string;
  warnings: string[];
}

/**
 * Schema-level validation only. Cross-reference rules (members exist, hashes resolve,
 * edges point at real nodes, cycles bounded, delegation scoped) live in `validate.ts`
 * because they need the database.
 */
export function validateSystemDefinition(json: unknown): ValidatedTeam<AgentSystemDefinition> {
  if (!validateSystem(json)) {
    throw new Error(`Schema validation failed: ${formatErrors(validateSystem.errors)}`);
  }
  const definition = json as AgentSystemDefinition;
  const warnings: string[] = [];
  const ids = new Set<string>();
  for (const m of definition.team.members) {
    if (ids.has(m.memberId)) throw new Error(`Duplicate memberId: ${m.memberId}`);
    ids.add(m.memberId);
  }
  const workflowIds = new Set<string>();
  for (const w of definition.orchestration.workflows) {
    if (workflowIds.has(w.workflowId)) throw new Error(`Duplicate workflowId: ${w.workflowId}`);
    workflowIds.add(w.workflowId);
  }
  if (!workflowIds.has(definition.orchestration.defaultWorkflowId)) {
    throw new Error(`orchestration.defaultWorkflowId '${definition.orchestration.defaultWorkflowId}' is not a declared workflow`);
  }
  for (const m of definition.team.members) {
    if (!m.agentRef.definitionHash) {
      warnings.push(`member '${m.memberId}' has no pinned definitionHash — the run will pin the agent's current version at start`);
    }
  }
  return { definition, definitionHash: hashDefinition(definition), warnings };
}

export function validateWorkflowDefinition(json: unknown): ValidatedTeam<WorkflowDefinition> {
  if (!validateWorkflow(json)) {
    throw new Error(`Workflow schema validation failed: ${formatErrors(validateWorkflow.errors)}`);
  }
  return { definition: json as WorkflowDefinition, definitionHash: hashDefinition(json), warnings: [] };
}

export function validateRunSnapshot(json: unknown): { ok: boolean; errors?: string } {
  if (validateSnapshot(json)) return { ok: true };
  return { ok: false, errors: formatErrors(validateSnapshot.errors) };
}

/** Extract one workflow by id from a system definition (throws with a clear error). */
export function findWorkflow(system: AgentSystemDefinition, workflowId?: string): WorkflowDefinition {
  const id = workflowId?.trim() || system.orchestration.defaultWorkflowId;
  const found = system.orchestration.workflows.find((w) => w.workflowId === id);
  if (!found) throw new Error(`workflow '${id}' is not part of team '${system.metadata.id}'`);
  return found;
}
