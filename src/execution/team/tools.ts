import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TeamTool } from './executor.js';
import type { CommunicationPolicy, TeamMessageType } from '../../systems/types.js';
import type { TeamStore } from '../../store/teams.js';
import { artifactsDirFor, publishArtifact } from './artifacts.js';

export interface TeamToolContext {
  store: TeamStore;
  systemRunId: string;
  memberId: string;
  roles: Map<string, string>;
  /** Manager member id for the active workflow (peer-messaging policy needs it). */
  managerId?: string;
  runWorkspace: string;
  memberWorkspace: string;
  nodeId: string;
  policy: CommunicationPolicy;
  /** Shared per-turn counter so tool calls and output.replies cannot exceed the budget. */
  budget?: { sent: number };
  emit: (kind: string, payload: Record<string, unknown>) => void;
}

const MESSAGE_TYPES: TeamMessageType[] = [
  'message', 'task-request', 'clarification', 'proposal', 'review-request',
  'review-response', 'decision', 'handoff', 'status-update', 'escalation',
];

function coerceTargets(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

/** Communication policy gate: with peer-to-peer off, only the manager may be addressed by members. */
export function messagingAllowed(ctx: { memberId: string; managerId?: string; policy: CommunicationPolicy }, targets: string[]): { ok: boolean; reason?: string } {
  if (ctx.policy.enabled === false) return { ok: false, reason: 'team communication is disabled for this workflow' };
  if (ctx.policy.allowPeerToPeer !== false) return { ok: true };
  if (!ctx.managerId) return { ok: false, reason: 'peer-to-peer messaging is disabled and this workflow has no manager to route through' };
  const outsiders = targets.filter((t) => t !== ctx.managerId && t !== ctx.memberId);
  if (ctx.memberId !== ctx.managerId && outsiders.length) {
    return { ok: false, reason: `peer-to-peer messaging is disabled: message ${ctx.managerId} (the manager) instead of ${outsiders.join(', ')}` };
  }
  return { ok: true };
}

export function buildTeamTools(ctx: TeamToolContext): TeamTool[] {
  const artifactsDir = artifactsDirFor(ctx.runWorkspace);
  const known = (): string[] => [...ctx.roles.keys()];
  const maxMessages = Math.max(0, ctx.policy.maxMessagesPerTurn ?? 2);
  const maxChars = Math.max(120, ctx.policy.maxBodyChars ?? 600);
  const canSend = (): string | undefined =>
    (ctx.budget?.sent ?? 0) >= maxMessages ? `message budget reached (${maxMessages} per turn); put status in team_report_progress and finish the task` : undefined;
  const cap = (body: string): { body: string; truncated: boolean } => {
    const clean = body.replace(/\r\n/g, '\n').trim();
    return clean.length > maxChars
      ? { body: `${clean.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`, truncated: true }
      : { body: clean, truncated: false };
  };
  const note = (): void => { if (ctx.budget) ctx.budget.sent++; };

  const sendMessage: TeamTool = {
    name: 'team_send_message',
    description: 'Send a persisted message to another team member through the orchestrator. Use it to ask a question, hand off work, request a review, or record a decision. The recipient receives it at the start of their next turn.',
    skipPermission: true,
    parameters: {
      type: 'object',
      properties: {
        to: { description: `Recipient member id (known: ${known().join(', ')}). A comma-separated list or array is allowed.` },
        type: { type: 'string', enum: MESSAGE_TYPES, description: 'Message kind. Defaults to message.' },
        body: { description: 'The message body.' },
        replyTo: { description: 'Optional id of a message you are answering.' },
      },
      required: ['to', 'body'],
    },
    handler: async (args) => {
      const targets = coerceTargets(args.to);
      if (!targets.length) return { ok: false, error: 'to is required' };
      const unknown = targets.filter((t) => !ctx.roles.has(t));
      if (unknown.length) return { ok: false, error: `unknown member(s): ${unknown.join(', ')}; team is ${known().join(', ')}` };
      const gate = messagingAllowed(ctx, targets);
      if (!gate.ok) return { ok: false, error: gate.reason };
      const blocked = canSend();
      if (blocked) return { ok: false, error: blocked };
      const type = MESSAGE_TYPES.includes(args.type as TeamMessageType) ? (args.type as TeamMessageType) : 'message';
      const capped = cap(String(args.body ?? ''));
      if (!capped.body) return { ok: false, error: 'message body is empty' };
      if (type === 'status-update') {
        const evolving = ctx.store.upsertStatusUpdate({
          systemRunId: ctx.systemRunId, from: ctx.memberId, to: targets,
          body: capped.body, nodeId: ctx.nodeId,
        });
        note();
        ctx.emit('message.sent', { messageId: evolving.id, from: ctx.memberId, to: targets, type, coalesced: !evolving.created });
        return { ok: true, messageId: evolving.id, deliveredTo: targets, coalesced: !evolving.created, truncated: capped.truncated };
      }
      const messageId = ctx.store.addMessage({
        systemRunId: ctx.systemRunId,
        from: ctx.memberId,
        to: targets,
        type,
        body: capped.body,
        replyTo: typeof args.replyTo === 'string' ? args.replyTo : null,
        nodeId: ctx.nodeId,
      });
      note();
      ctx.emit('message.sent', { messageId, from: ctx.memberId, to: targets, type, truncated: capped.truncated });
      return { ok: true, messageId, deliveredTo: targets, truncated: capped.truncated };
    },
  };

  const publish: TeamTool = {
    name: 'team_publish_artifact',
    description: 'Publish a deliverable to the shared run workspace. Versioned per member and name. Required artifact types must be published before your task can be accepted.',
    skipPermission: true,
    parameters: {
      type: 'object',
      properties: {
        type: { description: 'Artifact type, e.g. requirements-document, architecture-decision-record, test-results, acceptance-report.' },
        name: { description: 'File name, e.g. requirements.md.' },
        content: { description: 'Full document content. When omitted, the file with this name is read from your workspace.' },
      },
      required: ['type', 'name'],
    },
    handler: async (args) => {
      const row = publishArtifact(
        { store: ctx.store, systemRunId: ctx.systemRunId, memberId: ctx.memberId, artifactsDir, nodeId: ctx.nodeId, emit: ctx.emit },
        { type: String(args.type ?? 'document'), name: String(args.name ?? 'artifact.txt'), content: typeof args.content === 'string' ? args.content : undefined, memberWorkspace: ctx.memberWorkspace },
      );
      return { ok: true, artifactId: row.id, name: row.name, version: row.version, contentHash: row.content_hash, path: row.path };
    },
  };

  const list: TeamTool = {
    name: 'team_list_artifacts',
    description: 'List the deliverables published so far in this team run, so you can build on approved upstream work instead of guessing.',
    skipPermission: true,
    parameters: { type: 'object', properties: {} },
    handler: async () => {
      const rows = ctx.store.listArtifacts(ctx.systemRunId);
      return {
        ok: true,
        artifacts: rows.map((r) => ({ id: r.id, memberId: r.member_id, type: r.type, name: r.name, version: r.version, hash: r.content_hash, path: r.path })),
      };
    },
  };

  const read: TeamTool = {
    name: 'team_read_artifact',
    description: 'Read a published deliverable by id (from team_list_artifacts) or by its shared path.',
    skipPermission: true,
    parameters: {
      type: 'object',
      properties: { artifactId: { description: 'Artifact id.' }, name: { description: 'Artifact file name (latest version).' } },
    },
    handler: async (args) => {
      let row = typeof args.artifactId === 'string' ? ctx.store.getArtifact(args.artifactId) : undefined;
      if (!row && typeof args.name === 'string') {
        row = ctx.store.listArtifacts(ctx.systemRunId).find((a) => a.name === String(args.name));
      }
      if (!row) return { ok: false, error: 'artifact not found' };
      const candidate = row.path && existsSync(row.path) ? row.path : '';
      if (!existsSync(candidate)) return { ok: false, error: 'artifact content is no longer on disk' };
      return { ok: true, artifactId: row.id, name: row.name, type: row.type, version: row.version, content: readFileSync(candidate, 'utf8').slice(0, 20000) };
    },
  };

  const review: TeamTool = {
    name: 'team_request_review',
    description: 'Ask a specific member to review work, opening a review thread that their next turn must answer.',
    skipPermission: true,
    parameters: {
      type: 'object',
      properties: { from: { description: 'Reviewer member id.' }, subject: { description: 'What needs reviewing.' }, body: { description: 'Context for the reviewer.' } },
      required: ['from', 'body'],
    },
    handler: async (args) => {
      const target = String(args.from ?? '');
      if (!ctx.roles.has(target)) return { ok: false, error: `unknown member '${target}'` };
      const gate = messagingAllowed(ctx, [target]);
      if (!gate.ok) return { ok: false, error: gate.reason };
      const blocked = canSend();
      if (blocked) return { ok: false, error: blocked };
      const capped = cap(`${String(args.subject ?? 'Review requested')}\n\n${String(args.body ?? '')}`);
      const messageId = ctx.store.addMessage({
        systemRunId: ctx.systemRunId,
        from: ctx.memberId,
        to: [target],
        type: 'review-request',
        body: capped.body,
        nodeId: ctx.nodeId,
      });
      note();
      ctx.emit('message.sent', { messageId, from: ctx.memberId, to: [target], type: 'review-request', truncated: capped.truncated });
      return { ok: true, messageId, reviewer: target, truncated: capped.truncated };
    },
  };

  const progress: TeamTool = {
    name: 'team_report_progress',
    description: 'Update your progress on the shared board. Use this for status instead of chatting: it is visible to the operator and the manager without adding messages. Percent is 0-100.',
    skipPermission: true,
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'working | blocked | done | failed' },
        percent: { type: 'integer', description: '0-100' },
        phase: { type: 'string', description: 'Short phase label, e.g. api, tests, review.' },
        summary: { type: 'string', description: 'One short sentence.' },
      },
      required: ['status', 'summary'],
    },
    handler: async (args) => {
      const status = ['working', 'blocked', 'done', 'failed'].includes(String(args.status)) ? String(args.status) : 'working';
      const percent = Number.isFinite(Number(args.percent)) ? Number(args.percent) : status === 'done' ? 100 : 50;
      ctx.store.upsertMemberProgress({
        systemRunId: ctx.systemRunId, memberId: ctx.memberId, status, percent,
        phase: String(args.phase ?? '').trim() || null, summary: String(args.summary ?? '').trim().slice(0, 300),
      });
      ctx.emit('progress.updated', { memberId: ctx.memberId, status, percent, phase: String(args.phase ?? ''), summary: String(args.summary ?? '').slice(0, 300) });
      return { ok: true, memberId: ctx.memberId, status, percent };
    },
  };

  return [sendMessage, publish, list, read, review, progress];
}
