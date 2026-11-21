import type { ConditionOperator, EdgeCondition, NodeOutput } from '../../systems/types.js';

/**
 * Workflow edge conditions are data, never code. This evaluator supports a fixed
 * operator set over a dotted path — deliberately no `eval`, no `new Function`, and
 * no expression language, so a workflow JSON document can never execute code.
 */
export function resolvePath(root: unknown, path: string): unknown {
  if (!path) return undefined;
  const parts = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((s) => s.trim())
    .filter(Boolean);
  let cur: unknown = root;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (part === 'length') {
      if (Array.isArray(cur) || typeof cur === 'string') return (cur as { length: number }).length;
      if (typeof cur === 'object') return Object.keys(cur as object).length;
      return undefined;
    }
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function evaluateCondition(cond: EdgeCondition | undefined, output: NodeOutput): boolean {
  if (!cond) return true;
  // Conditions are written against the node result (`output.status`) but custom
  // top-level keys from the member's JSON block stay addressable (`managerDecision.status`).
  const actual = resolvePath({ ...output, output }, cond.path);
  return compare(cond.operator, actual, cond.value);
}

export function compare(op: ConditionOperator, actual: unknown, expected: unknown): boolean {
  switch (op) {
    case 'exists':
      return expected === false ? actual === undefined || actual === null : actual !== undefined && actual !== null;
    case 'equals':
      return looseEquals(actual, expected);
    case 'not-equals':
      return !looseEquals(actual, expected);
    case 'in': {
      if (!Array.isArray(expected)) return false;
      return expected.some((v) => looseEquals(actual, v));
    }
    case 'contains': {
      if (typeof actual === 'string') return actual.includes(String(expected ?? ''));
      if (Array.isArray(actual)) return actual.some((v) => looseEquals(v, expected));
      return false;
    }
    case 'gt':
    case 'lt':
    case 'gte':
    case 'lte': {
      const a = toNumber(actual);
      const b = toNumber(expected);
      if (a === undefined || b === undefined) return false;
      return op === 'gt' ? a > b : op === 'lt' ? a < b : op === 'gte' ? a >= b : a <= b;
    }
    case 'matches': {
      if (typeof actual !== 'string') return false;
      const pattern = String(expected ?? '');
      if (!pattern || pattern.length > 200) return false;
      try { return new RegExp(pattern, 'i').test(actual); } catch { return false; }
    }
    default:
      return false;
  }
}

function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
  if (typeof a === 'number' && typeof b === 'string') return String(a) === b;
  if (typeof a === 'string' && typeof b === 'number') return a === String(b);
  if (Array.isArray(a) && Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/**
 * Pick the outgoing edges that fire for a node result.
 *
 * Unconditional edges always fire. Conditional edges fire when their condition
 * matches. When a node declares at least one *conditional* outgoing edge and none
 * of them match, nothing fires and the engine reports a stalled transition — that
 * is a modelled outcome (e.g. `failed` with no recovery path), not a silent advance.
 */
export function satisfiedEdges<T extends { from: string; when?: EdgeCondition; label?: string }>(edges: T[], from: string, output: NodeOutput): T[] {
  const outgoing = edges.filter((e) => e.from === from);
  const conditional = outgoing.filter((e) => e.when);
  const unconditional = outgoing.filter((e) => !e.when);
  const fired = conditional.filter((e) => evaluateCondition(e.when, output));
  return [...unconditional, ...fired];
}
