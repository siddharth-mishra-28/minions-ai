import type { NodeOutput, TeamMessage } from '../../systems/types.js';

/**
 * Members answer in prose plus one fenced JSON block. Parsing that block is what
 * makes workflow transitions data-driven instead of string matching on prose.
 *
 * Recognised keys: status, summary, artifacts[], replies[], decisions[], tasks[],
 * message. Anything else is preserved verbatim so workflows can branch on it.
 */
export function parseNodeOutput(text: string): NodeOutput {
  const raw = String(text ?? '');
  const json = extractJsonObject(raw);
  if (!json) return { status: 'done', raw, summary: firstLines(raw, 400) };
  const output: NodeOutput = { ...json, raw } as NodeOutput;
  output.status = normalizeStatus(json.status);
  if (!output.summary && typeof json.message === 'string') output.summary = json.message;
  if (!output.summary) output.summary = firstLines(raw, 400);
  if (json.artifacts !== undefined && !Array.isArray(json.artifacts)) output.artifacts = [];
  if (json.replies !== undefined && !Array.isArray(json.replies)) output.replies = [];
  return output;
}

function normalizeStatus(v: unknown): string {
  if (typeof v !== 'string' || !v.trim()) return 'done';
  return v.trim().toLowerCase();
}

/** Last fenced ```json block wins (models often restate an example earlier). */
function extractJsonObject(text: string): Record<string, unknown> | undefined {
  const candidates: string[] = [];
  const fence = /```(?:json|JSON)?\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text))) candidates.push(m[1]);
  candidates.reverse();
  for (const c of candidates) {
    const parsed = tryParse(c);
    if (parsed) return parsed;
  }
  // Bare object response (no fence).
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const parsed = tryParse(trimmed);
    if (parsed) return parsed;
  }
  return undefined;
}

function tryParse(text: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(text.trim()) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch { return undefined; }
}

function firstLines(text: string, max: number): string {
  const clean = text.replace(/```[\s\S]*?```/g, '').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

export interface MessageDelivery {
  id: string;
  from_member: string;
  type: string;
  body: string;
  task_id?: string | null;
  created_at: string;
}

/** Render undelivered messages as the head of a member's next brief. */
export function renderInbox(messages: (TeamMessage & { to_members?: string[] })[], self: string, roles: Map<string, string>): string {
  if (!messages.length) return '';
  const lines = messages.map((m) => {
    const from = roles.get(m.from_member) ?? m.from_member;
    return `- [${m.type}] from ${m.from_member} (${from}) at ${m.created_at.slice(11, 16)}: ${m.body.replace(/\s+/g, ' ').trim().slice(0, 1200)}`;
  });
  return [
    `## Messages awaiting ${self}`,
    'These were sent to you through the orchestrator. Act on the ones that need you; do not send an acknowledgement just to be polite.',
    'If you must answer, keep it to one short message that unblocks the sender. Put routine status in `progress`, not chat.',
    ...lines,
  ].join('\n');
}

/** Standard response contract appended to every member brief. */
export const OUTPUT_CONTRACT_PROMPT = [
  '## Response contract (required)',
  'Finish with exactly one fenced ```json block. The orchestrator routes work from it — prose alone cannot advance the workflow.',
  '```json',
  '{',
  '  "status": "done | passed | failed | changes-requested | accepted | blocked",',
  '  "summary": "one or two sentences a manager could read",',
  '  "progress": { "percent": 60, "phase": "api", "summary": "Endpoints implemented; tests next." },',
  '  "artifacts": [{ "type": "requirements-document", "name": "requirements.md", "content": "full document text" }],',
  '  "replies": [{ "to": "architect", "type": "review-response", "body": "answer or decision" }],',
  '  "decisions": [{ "memberId": "developer", "decision": "approved", "rationale": "why" }],',
  '  "tasks": [{ "memberId": "developer", "title": "API layer", "task": "what to build", "dependsOn": [] }]',
  '}',
  '```',
  'Only include the keys you need. `tasks` is for managers delegating work; `replies` is how you answer another member. Never invent artifact content you did not actually produce.',
  '## Chat discipline',
  'The team channel is for work that needs another person: handoffs, blockers, review requests, decisions and escalations. It is not a narration feed.',
  'Use `progress` or team_report_progress for status. Do not send greetings, acknowledgements, or a message that only repeats your summary. At most one short message per turn; the orchestrator enforces a hard budget.',
  'If you are the manager and the objective has not been delegated yet, `tasks` is mandatory: answering `complete` before any work was delegated ends the run with nothing delivered.',
].join('\n');
