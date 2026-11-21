import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { TeamService } from '../systems/service.js';
import type { TeamStore } from '../store/teams.js';
import type { TeamHub } from '../execution/team/hub.js';
import { TeamError } from '../systems/service.js';
import { memberCard, platformCard, teamCard } from './cards.js';
import { buildTask, eventToA2AUpdate, partsToText, type RunRow } from './mapper.js';
import {
  A2A_ERRORS, type A2AArtifactUpdateEvent, type A2AJsonRpcError, type A2AJsonRpcRequest,
  type A2AMessage, type A2AStatusUpdateEvent, type A2ATask,
} from './types.js';

interface A2AContext {
  teams: TeamService;
  store: TeamStore;
  hub: TeamHub;
  isActive?: (runId: string) => boolean;
}

const TEAM_PARAMS = {
  type: 'object',
  properties: { teamId: { type: 'string' } },
  required: ['teamId'],
} as const;

const MEMBER_PARAMS = {
  type: 'object',
  properties: { teamId: { type: 'string' }, memberId: { type: 'string' } },
  required: ['teamId', 'memberId'],
} as const;

const BODY = { type: 'object', additionalProperties: true } as const;

function isLoopback(ip: string | undefined): boolean {
  if (!ip) return true;
  const v = ip.toLowerCase();
  return v === '127.0.0.1' || v === '::1' || v === '::ffff:127.0.0.1' || v.startsWith('127.');
}

/** A2A is loopback-only unless a token is configured; a token makes remote exposure safe. */
function authorized(req: FastifyRequest, reply: FastifyReply): boolean {
  const token = process.env.A2A_TOKEN?.trim();
  if (token) {
    const header = String(req.headers.authorization ?? '');
    if (header !== `Bearer ${token}`) {
      void reply.code(401).send({ error: 'A2A bearer token required' });
      return false;
    }
    return true;
  }
  if (!isLoopback(req.ip)) {
    void reply.code(403).send({ error: 'A2A is loopback-only; set A2A_TOKEN to expose it remotely' });
    return false;
  }
  return true;
}

function baseUrl(req: FastifyRequest): string {
  const configured = process.env.A2A_PUBLIC_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  const host = req.headers.host ?? `127.0.0.1:${(req.socket.localPort ?? 3100)}`;
  return `${req.protocol}://${host}`;
}

function rpcOk<T>(id: string | number | null, result: T): { jsonrpc: '2.0'; id: string | number | null; result: T } {
  return { jsonrpc: '2.0' as const, id, result };
}

function rpcErr(reply: FastifyReply, id: string | number | null, code: number, message: string, data?: unknown): void {
  const body: A2AJsonRpcError = { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
  // JSON-RPC errors are HTTP 200 unless the transport itself failed.
  void reply.code(200).send(body);
}

function runFor(store: TeamStore, runId: string): RunRow | undefined {
  const row = store.getSystemRun(runId) as (Record<string, unknown> & RunRow) | undefined;
  return row;
}

function taskFor(store: TeamStore, run: RunRow, includeArtifactContent = false): A2ATask {
  return buildTask(store, run, { historyLimit: 200, includeArtifactContent });
}

function sendParams(params: Record<string, unknown> | undefined): { message: A2AMessage; metadata: Record<string, unknown> } | undefined {
  const message = params?.message as A2AMessage | undefined;
  if (!message || message.kind !== 'message' || !Array.isArray(message.parts)) return undefined;
  const metadata = {
    ...(typeof params?.metadata === 'object' && params.metadata ? params.metadata as Record<string, unknown> : {}),
    ...(message.metadata ?? {}),
  };
  return { message, metadata };
}

function terminal(status: string): boolean {
  return ['done', 'failed', 'stopped', 'interrupted'].includes(status);
}

/**
 * Resolve a `message/send` into a run. A new context starts a pinned run; an existing
 * context queues the operator's message so it is delivered at the recipient's next turn.
 */
function resolveSend(ctx: A2AContext, teamId: string, params: Record<string, unknown> | undefined, memberId?: string):
  { runId: string; task: A2ATask; created: boolean } | { error: { code: number; message: string } } {
  const parsed = sendParams(params);
  if (!parsed) return { error: { code: A2A_ERRORS.invalidParams, message: 'params.message with parts[] is required' } };
  const text = partsToText(parsed.message.parts);
  if (!text) return { error: { code: A2A_ERRORS.invalidParams, message: 'message has no text parts' } };
  const system = ctx.store.getSystem(teamId);
  if (!system) return { error: { code: A2A_ERRORS.taskNotFound, message: `team not found: ${teamId}` } };

  const contextId = String(parsed.message.contextId ?? parsed.metadata.contextId ?? '').trim();
  if (contextId) {
    const run = runFor(ctx.store, contextId);
    if (!run) return { error: { code: A2A_ERRORS.taskNotFound, message: `task not found: ${contextId}` } };
    if (run.system_id !== teamId) return { error: { code: A2A_ERRORS.invalidParams, message: `task ${contextId} does not belong to team ${teamId}` } };
    if (terminal(String(run.status))) return { error: { code: A2A_ERRORS.invalidParams, message: `task ${contextId} is ${run.status} and cannot accept messages` } };
    let to: string[];
    if (memberId) {
      const snapshot = JSON.parse(String(run.snapshot_json ?? '{}')) as { resolvedMembers?: { memberId: string }[]; addedMembers?: { memberId: string }[] };
      const known = new Set([...(snapshot.resolvedMembers ?? []), ...(snapshot.addedMembers ?? [])].map((m) => m.memberId));
      if (!known.has(memberId)) return { error: { code: A2A_ERRORS.invalidParams, message: `member not part of run: ${memberId}` } };
      to = [memberId];
    } else {
      const snapshot = JSON.parse(String(run.snapshot_json ?? '{}')) as { resolvedMembers?: { memberId: string }[]; addedMembers?: { memberId: string }[] };
      to = [...(snapshot.resolvedMembers ?? []), ...(snapshot.addedMembers ?? [])].map((m) => m.memberId);
    }
    const messageId = ctx.store.addMessage({
      systemRunId: contextId, from: 'operator', to, type: 'message', body: text,
      messageId: parsed.message.messageId, contextId, protocol: 'a2a',
      parts: parsed.message.parts,
    });
    ctx.store.appendEvent({
      systemRunId: contextId, kind: 'message.operator',
      payload: { messageId, to, protocol: 'a2a', from: 'operator' },
    });
    const run2 = runFor(ctx.store, contextId)!;
    return { runId: contextId, task: taskFor(ctx.store, run2), created: false };
  }

  try {
    const started = ctx.teams.startRun(teamId, {
      task: text,
      workflowId: typeof parsed.metadata.workflowId === 'string' ? parsed.metadata.workflowId : undefined,
      workspace: typeof parsed.metadata.workspace === 'string' ? parsed.metadata.workspace : undefined,
      limits: typeof parsed.metadata.limits === 'object' && parsed.metadata.limits ? parsed.metadata.limits as Record<string, number> : undefined,
    }) as { runId?: string };
    const runId = String(started.runId ?? '');
    const run = runFor(ctx.store, runId);
    if (!run) return { error: { code: A2A_ERRORS.internal, message: 'run was created but cannot be read' } };
    const snapshot = JSON.parse(String(run.snapshot_json ?? '{}')) as { resolvedMembers?: { memberId: string }[] };
    const members = (snapshot.resolvedMembers ?? []).map((m) => m.memberId);
    if (memberId && !members.includes(memberId)) {
      return { error: { code: A2A_ERRORS.invalidParams, message: `member not part of run: ${memberId}` } };
    }
    // Record the exact A2A envelope once so an idempotent retry finds it.
    ctx.store.addMessage({
      systemRunId: runId, from: 'operator', to: memberId ? [memberId] : members, type: 'message', body: text,
      messageId: parsed.message.messageId, contextId: runId, protocol: 'a2a', parts: parsed.message.parts,
    });
    return { runId, task: taskFor(ctx.store, run), created: true };
  } catch (err) {
    if (err instanceof TeamError) return { error: { code: err.status === 404 ? A2A_ERRORS.taskNotFound : A2A_ERRORS.invalidParams, message: err.message } };
    return { error: { code: A2A_ERRORS.internal, message: (err as Error).message } };
  }
}

async function dispatch(ctx: A2AContext, req: FastifyRequest, reply: FastifyReply, teamId: string, memberId?: string): Promise<void> {
  const body = req.body as A2AJsonRpcRequest | undefined;
  const id = body?.id ?? null;
  if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    rpcErr(reply, id, A2A_ERRORS.invalidRequest, 'A JSON-RPC 2.0 request is required');
    return;
  }
  const method = body.method;
  const params = (body.params ?? {}) as Record<string, unknown>;

  if (method === 'message/send' || method === 'SendMessage') {
    const resolved = resolveSend(ctx, teamId, params, memberId);
    if ('error' in resolved) { rpcErr(reply, id, resolved.error.code, resolved.error.message); return; }
    void reply.code(200).send(rpcOk(id, resolved.task));
    return;
  }

  if (method === 'tasks/get' || method === 'GetTask') {
    const runId = String(params.id ?? '').trim();
    const run = runId ? runFor(ctx.store, runId) : undefined;
    if (!run || run.system_id !== teamId) { rpcErr(reply, id, A2A_ERRORS.taskNotFound, `task not found: ${runId}`); return; }
    void reply.code(200).send(rpcOk(id, taskFor(ctx.store, run, true)));
    return;
  }

  if (method === 'tasks/cancel' || method === 'CancelTask') {
    const runId = String(params.id ?? '').trim();
    const run = runId ? runFor(ctx.store, runId) : undefined;
    if (!run || run.system_id !== teamId) { rpcErr(reply, id, A2A_ERRORS.taskNotFound, `task not found: ${runId}`); return; }
    if (terminal(String(run.status))) { rpcErr(reply, id, A2A_ERRORS.taskNotCancelable, `task ${runId} is already ${run.status}`); return; }
    try { ctx.teams.stop(runId); } catch (err) { rpcErr(reply, id, A2A_ERRORS.internal, (err as Error).message); return; }
    const after = runFor(ctx.store, runId)!;
    void reply.code(200).send(rpcOk(id, taskFor(ctx.store, after)));
    return;
  }

  if (method === 'message/stream' || method === 'SendStreamingMessage') {
    const resolved = resolveSend(ctx, teamId, params, memberId);
    if ('error' in resolved) { rpcErr(reply, id, resolved.error.code, resolved.error.message); return; }
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const write = (payload: unknown): void => {
      try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { /* client went away */ }
    };
    write(rpcOk(id, resolved.task));
    let closed = false;
    const finish = (event: A2AStatusUpdateEvent | A2AArtifactUpdateEvent): void => {
      write(rpcOk(id, event));
      if (event.kind === 'status-update' && event.final) {
        closed = true;
        cleanup();
        try { res.end(); } catch { /* closed */ }
      }
    };
    let lastSeq = 0;
    const current = runFor(ctx.store, resolved.runId);
    if (current && terminal(String(current.status))) {
      finish({ kind: 'status-update', taskId: resolved.runId, contextId: resolved.runId, status: { state: current.status === 'done' ? 'completed' : current.status === 'stopped' ? 'canceled' : 'failed', timestamp: current.finished_at ?? new Date().toISOString() }, final: true });
      return;
    }
    for (const event of ctx.store.listEvents(resolved.runId)) {
      lastSeq = Math.max(lastSeq, event.seq);
      const mapped = eventToA2AUpdate(ctx.store, resolved.runId, event);
      if (mapped) finish(mapped);
      if (closed) return;
    }
    const unsubscribe = ctx.hub.subscribe(resolved.runId, (event) => {
      if (closed) return;
      if (event.seq <= lastSeq) return;
      lastSeq = event.seq;
      const mapped = eventToA2AUpdate(ctx.store, resolved.runId, event);
      if (mapped) finish(mapped);
    });
    const keepAlive = setInterval(() => { try { res.write(': keep-alive\n\n'); } catch { /* closed */ } }, 15_000);
    function cleanup(): void {
      clearInterval(keepAlive);
      unsubscribe();
    }
    req.raw.on('close', () => {
      closed = true;
      cleanup();
      try { res.end(); } catch { /* closed */ }
    });
    return;
  }

  if (method === 'tasks/list' || method === 'ListTasks') {
    const limit = Math.min(200, Math.max(1, Number(params.limit) || 50));
    const runs = ctx.store.listSystemRuns({ systemId: teamId, limit });
    void reply.code(200).send(rpcOk(id, { tasks: runs.map((r) => taskFor(ctx.store, r as unknown as RunRow)) }));
    return;
  }

  rpcErr(reply, id, A2A_ERRORS.methodNotFound, `method not found: ${method}`);
}

export async function registerA2ARoutes(app: FastifyInstance, ctx: A2AContext): Promise<void> {
  // Discovery is public; every RPC call is loopback-only unless A2A_TOKEN is set.
  app.get('/.well-known/agent-card.json', { schema: { tags: ['a2a'], summary: 'Platform A2A agent card' } }, async (req) => platformCard(baseUrl(req), ctx.store.listSystems()));
  app.get('/a2a', { schema: { tags: ['a2a'], summary: 'Platform A2A agent card (alias)' } }, async (req) => platformCard(baseUrl(req), ctx.store.listSystems()));

  app.get('/a2a/:teamId/.well-known/agent-card.json', { schema: { tags: ['a2a'], summary: 'Team A2A agent card', params: TEAM_PARAMS } }, async (req, reply) => {
    const { teamId } = req.params as { teamId: string };
    const system = ctx.store.getSystem(teamId);
    if (!system) return reply.code(404).send({ error: `team not found: ${teamId}` });
    return teamCard(baseUrl(req), system);
  });
  app.get('/a2a/:teamId/agent-card.json', { schema: { tags: ['a2a'], summary: 'Team A2A agent card (alias)', params: TEAM_PARAMS } }, async (req, reply) => {
    const { teamId } = req.params as { teamId: string };
    const system = ctx.store.getSystem(teamId);
    if (!system) return reply.code(404).send({ error: `team not found: ${teamId}` });
    return teamCard(baseUrl(req), system);
  });
  app.get('/a2a/:teamId/members/:memberId/.well-known/agent-card.json', { schema: { tags: ['a2a'], summary: 'Member A2A agent card', params: MEMBER_PARAMS } }, async (req, reply) => {
    const { teamId, memberId } = req.params as { teamId: string; memberId: string };
    const system = ctx.store.getSystem(teamId);
    if (!system) return reply.code(404).send({ error: `team not found: ${teamId}` });
    const card = memberCard(baseUrl(req), system, memberId);
    return card ?? reply.code(404).send({ error: `member not found: ${memberId}` });
  });
  app.get('/a2a/:teamId/members/:memberId/agent-card.json', { schema: { tags: ['a2a'], summary: 'Member A2A agent card (alias)', params: MEMBER_PARAMS } }, async (req, reply) => {
    const { teamId, memberId } = req.params as { teamId: string; memberId: string };
    const system = ctx.store.getSystem(teamId);
    if (!system) return reply.code(404).send({ error: `team not found: ${teamId}` });
    const card = memberCard(baseUrl(req), system, memberId);
    return card ?? reply.code(404).send({ error: `member not found: ${memberId}` });
  });

  app.post('/a2a/:teamId', {
    schema: {
      tags: ['a2a'], summary: 'A2A JSON-RPC endpoint for a team',
      params: TEAM_PARAMS, body: BODY,
    },
  }, async (req, reply) => {
    if (!authorized(req, reply)) return;
    await dispatch(ctx, req, reply, (req.params as { teamId: string }).teamId);
  });

  app.post('/a2a/:teamId/members/:memberId', {
    schema: {
      tags: ['a2a'], summary: 'A2A JSON-RPC endpoint scoped to one team member',
      params: MEMBER_PARAMS, body: BODY,
    },
  }, async (req, reply) => {
    if (!authorized(req, reply)) return;
    const { teamId, memberId } = req.params as { teamId: string; memberId: string };
    await dispatch(ctx, req, reply, teamId, memberId);
  });

  // REST conveniences for humans and smoke tests; the JSON-RPC surface is canonical.
  app.get('/a2a/:teamId/tasks', { schema: { tags: ['a2a'], summary: 'List A2A tasks (team runs)', params: TEAM_PARAMS } }, async (req, reply) => {
    if (!authorized(req, reply)) return;
    const { teamId } = req.params as { teamId: string };
    if (!ctx.store.getSystem(teamId)) return reply.code(404).send({ error: `team not found: ${teamId}` });
    const runs = ctx.store.listSystemRuns({ systemId: teamId, limit: 50 });
    return { tasks: runs.map((r) => taskFor(ctx.store, r as unknown as RunRow)) };
  });
  app.get('/a2a/:teamId/tasks/:taskId', { schema: { tags: ['a2a'], summary: 'Read one A2A task', params: { type: 'object', properties: { teamId: { type: 'string' }, taskId: { type: 'string' } }, required: ['teamId', 'taskId'] } } }, async (req, reply) => {
    if (!authorized(req, reply)) return;
    const { teamId, taskId } = req.params as { teamId: string; taskId: string };
    const run = runFor(ctx.store, taskId);
    if (!run || run.system_id !== teamId) return reply.code(404).send({ error: `task not found: ${taskId}` });
    return taskFor(ctx.store, run, true);
  });

  // A tiny health probe keeps discovery failures obvious and avoids a bare 404 at /a2a.
  app.get('/a2a/health', { schema: { tags: ['a2a'], summary: 'A2A transport health' } }, async () => ({ ok: true, protocolVersion: '0.3.0', auth: process.env.A2A_TOKEN ? 'bearer' : 'loopback' }));
}
