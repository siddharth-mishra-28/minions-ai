import type { TeamMessage } from '../../systems/types.js';

/** Accept `to` as a single id, a comma list, or an array — models produce all three. */
export function deserializeMessageTargets(to: string | string[] | undefined | null): string[] {
  if (Array.isArray(to)) return to.map((t) => String(t).trim()).filter(Boolean);
  if (typeof to !== 'string') return [];
  return to.split(',').map((t) => t.trim()).filter(Boolean);
}

/** Render a persisted conversation as Markdown (used by exports and the run report). */
export function renderConversation(messages: (TeamMessage & { to_members?: string[] })[], roles: Map<string, string>): string {
  if (!messages.length) return '_No team messages._';
  return messages.map((m) => {
    const from = roles.get(m.from_member) ?? m.from_member;
    const to = (m.to_members ?? []).map((t) => roles.get(t) ?? t).join(', ') || 'team';
    return `- **${from} → ${to}** · ${m.type} · ${m.created_at}\n  ${m.body.replace(/\n/g, '\n  ')}`;
  }).join('\n');
}
