import type { FastifyInstance, FastifyReply } from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import { TeamError, type TeamService } from '../systems/service.js';
import type { TeamStore } from '../store/teams.js';
import type { TeamHub } from '../execution/team/hub.js';
import type { TeamMessageType } from '../systems/types.js';
import { renderConversation } from '../execution/team/messages.js';
import { errorSchema } from './route-schemas.js';

const MESSAGE_TYPES: TeamMessageType[] = [
  'message', 'task-request', 'clarification', 'proposal', 'review-request',
  'review-response', 'decision', 'handoff', 'status-update', 'escalation',
];

const idParam = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } as const;

function fail(reply: FastifyReply, err: unknown): unknown {
  if (err instanceof TeamError) return reply.code(err.status).send({ error: err.message });
  return reply.code(400).send({ error: (err as Error).message });
}

/**
 * Team orchestration API.
 *
 * Definitions follow the same lifecycle as single agents (draft → validate → publish),
 * but publishing freezes a *version* that runs pin. Everything under `/api/team-runs`
 * is the operational surface: events for the live timeline, node runs for the
 * execution tree, messages for the team chat, artifacts and handoffs for deliverables,
 * and approvals for human gates.
 */
export async function registerTeamRoutes(
  app: FastifyInstance,
  ctx: { teams: TeamService; store: TeamStore; hub: TeamHub; isActive?: (runId: string) => boolean },
): Promise<void> {
  const { teams, store, hub } = ctx;

  // ------------------------------------------------------------------ definitions
  app.get('/api/teams', { schema: { tags: ['teams'], summary: 'List agent teams with member/workflow summaries' } }, async () => ({ teams: teams.list() }));

  app.post('/api/teams', {
    schema: {
      tags: ['teams'], summary: 'Create a team definition (draft; run after publishing)',
      body: { type: 'object', required: ['definition'], properties: { definition: { type: 'object', additionalProperties: true } } },
      response: { 400: errorSchema, 409: errorSchema },
    },
  }, async (req, reply) => {
    try { return teams.create(req.body); } catch (err) { return fail(reply, err); }
  });

  app.get('/api/teams/:id', { schema: { tags: ['teams'], summary: 'Team + validation report + published versions', params: idParam, response: { 404: errorSchema } } }, async (req, reply) => {
    const t = teams.get((req.params as { id: string }).id);
    return t ?? reply.code(404).send({ error: 'team not found' });
  });

  app.put('/api/teams/:id', {
    schema: {
      tags: ['teams'], summary: 'Replace the editable draft (published versions are untouched)',
      params: idParam,
      body: { type: 'object', required: ['definition'], properties: { definition: { type: 'object', additionalProperties: true } } },
      response: { 400: errorSchema, 404: errorSchema },
    },
  }, async (req, reply) => {
    try { return teams.update((req.params as { id: string }).id, req.body); } catch (err) { return fail(reply, err); }
  });

  app.delete('/api/teams/:id', { schema: { tags: ['teams'], summary: 'Delete a team that has no run history', params: idParam, response: { 404: errorSchema, 409: errorSchema } } }, async (req, reply) => {
    try { return { deleted: teams.remove((req.params as { id: string }).id) }; } catch (err) { return fail(reply, err); }
  });

  app.post('/api/teams/:id/validate', {
    schema: {
      tags: ['teams'], summary: 'Validate a definition (the stored draft, or the definition in the body)',
      params: idParam,
      body: { type: 'object', properties: { definition: { type: 'object', additionalProperties: true } } },
      response: { 404: errorSchema },
    },
  }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as { definition?: unknown };
    if (body.definition) return teams.validate(body.definition);
    const t = teams.get(id);
    if (!t) return reply.code(404).send({ error: 'team not found' });
    return t.validation;
  });

  app.post('/api/teams/:id/publish', {
    schema: {
      tags: ['teams'], summary: 'Publish an immutable, runnable team version',
      params: idParam,
      body: { type: 'object', properties: { version: { type: 'string', maxLength: 40 } } },
      response: { 400: errorSchema, 404: errorSchema },
    },
  }, async (req, reply) => {
    try { return teams.publish((req.params as { id: string }).id, (req.body as { version?: string } | undefined)?.version); } catch (err) { return fail(reply, err); }
  });

  app.get('/api/teams/:id/versions', { schema: { tags: ['teams'], summary: 'Published version history', params: idParam, response: { 404: errorSchema } } }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!store.getSystem(id)) return reply.code(404).send({ error: 'team not found' });
    return { versions: store.listSystemVersions(id), workflows: store.listWorkflowVersions(id) };
  });

  // ----------------------------------------------------------------------- runs
  app.post('/api/teams/:id/runs', {
    schema: {
      tags: ['teams'], summary: 'Start a run pinned to the published version (returns immediately)',
      params: idParam,
      body: {
        type: 'object',
        properties: {
          task: { type: 'string', maxLength: 20000 },
          workflowId: { type: 'string' },
          workspace: { type: 'string' },
          limits: {
            type: 'object',
            properties: {
              maxDurationMs: { type: 'integer', minimum: 1000 },
              maxNodeRuns: { type: 'integer', minimum: 1 },
              maxIterations: { type: 'integer', minimum: 1 },
              maxConcurrentTasks: { type: 'integer', minimum: 1 },
              maxAttempts: { type: 'integer', minimum: 1 },
              backoffMs: { type: 'integer', minimum: 0 },
              retryBackoffMultiplier: { type: 'number', minimum: 1 },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      response: { 400: errorSchema, 404: errorSchema, 409: errorSchema },
    },
  }, async (req, reply) => {
    try { return teams.startRun((req.params as { id: string }).id, (req.body ?? {}) as { task?: string; workflowId?: string; workspace?: string; limits?: import('../systems/types.js').WorkflowLimits }); } catch (err) { return fail(reply, err); }
  });

  app.get('/api/team-runs', {
    schema: {
      tags: ['teams'], summary: 'Team runs (filter by team or status)',
      querystring: { type: 'object', properties: { systemId: { type: 'string' }, status: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 500 } } },
    },
  }, async (req) => {
    const q = req.query as { systemId?: string; status?: string; limit?: number };
    return { runs: store.listSystemRuns(q) };
  });

  app.get('/api/team-runs/:id', { schema: { tags: ['teams'], summary: 'Run detail: snapshot, node runs, sessions, artifacts, handoffs, counts', params: idParam, response: { 404: errorSchema } } }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const run = store.getSystemRun(id);
    if (!run) return reply.code(404).send({ error: `team run not found: ${id}` });
    let snapshot: unknown = undefined;
    try { snapshot = JSON.parse(String(run.snapshot_json ?? '{}')); } catch { snapshot = undefined; }
    const artifacts = store.listArtifacts(id);
    const handoffs = store.listHandoffs(id);
    const messages = store.listMessages(id, { limit: 1000 });
    return {
      run: { ...run, snapshot_json: undefined }, snapshot,
      nodes: store.listNodeRuns(id), sessions: store.listRunSessions(id),
      artifacts, handoffs, messageCount: messages.length,
      progress: store.listMemberProgress(id),
      active: ctx.isActive?.(id) ?? false,
    };
  });

  app.get('/api/team-runs/:id/progress', { schema: { tags: ['teams'], summary: 'Per-member progress for a run', params: idParam, response: { 404: errorSchema } } }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!store.getSystemRun(id)) return reply.code(404).send({ error: `team run not found: ${id}` });
    const items = store.listMemberProgress(id);
    const byStatus = items.reduce<Record<string, number>>((acc, row) => {
      acc[row.status] = (acc[row.status] ?? 0) + 1;
      return acc;
    }, {});
    return { runId: id, items, byStatus, updatedAt: items.reduce<string | null>((latest, row) => (!latest || row.updated_at > latest ? row.updated_at : latest), null) };
  });

  app.post('/api/team-runs/:id/stop', { schema: { tags: ['teams'], summary: 'Stop a run (in-flight turns are aborted)', params: idParam, response: { 404: errorSchema } } }, async (req, reply) => {
    try { teams.stop((req.params as { id: string }).id); return { ok: true }; } catch (err) { return fail(reply, err); }
  });

  app.post('/api/team-runs/:id/resume', { schema: { tags: ['teams'], summary: 'Resume an interrupted run from its last persisted frontier', params: idParam, response: { 404: errorSchema, 409: errorSchema } } }, async (req, reply) => {
    try { teams.resume((req.params as { id: string }).id); return { ok: true, runId: (req.params as { id: string }).id }; } catch (err) { return fail(reply, err); }
  });

  app.post('/api/team-runs/:id/nodes/:nodeId/approval', {
    schema: {
      tags: ['teams'], summary: 'Decide a human-approval gate',
      params: { type: 'object', properties: { id: { type: 'string' }, nodeId: { type: 'string' } }, required: ['id', 'nodeId'] },
      body: { type: 'object', required: ['decision'], properties: { decision: { type: 'string', enum: ['approved', 'rejected'] }, reason: { type: 'string', maxLength: 4000 } } },
      response: { 404: errorSchema, 409: errorSchema },
    },
  }, async (req, reply) => {
    const { id, nodeId } = req.params as { id: string; nodeId: string };
    const body = req.body as { decision: 'approved' | 'rejected'; reason?: string };
    try { teams.approveNode(id, nodeId, body.decision, body.reason); return { ok: true }; } catch (err) { return fail(reply, err); }
  });

  // --------------------------------------------------------------------- events
  app.get('/api/team-runs/:id/events', {
    schema: {
      tags: ['teams'], summary: 'Ordered run events (append-only audit trail)',
      params: idParam,
      querystring: { type: 'object', properties: { after: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 2000 } } },
      response: { 404: errorSchema },
    },
  }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!store.getSystemRun(id)) return reply.code(404).send({ error: `team run not found: ${id}` });
    const q = req.query as { after?: number; limit?: number };
    const events = store.listEvents(id, q.after ?? 0);
    return { events: events.slice(0, q.limit ?? 2000), lastSeq: events.length ? events[events.length - 1].seq : (q.after ?? 0) };
  });

  app.get('/api/team-runs/:id/stream', { schema: { tags: ['teams'], summary: 'Server-sent events for a live run (replay from ?after=)', params: idParam, response: { 404: errorSchema } } }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!store.getSystemRun(id)) return reply.code(404).send({ error: `team run not found: ${id}` });
    const after = Number((req.query as { after?: string }).after ?? 0) || 0;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    for (const event of store.listEvents(id, after)) res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
    const unsubscribe = hub.subscribe(id, (event) => res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`));
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
    req.raw.on('close', () => { clearInterval(keepAlive); unsubscribe(); try { res.end(); } catch { /* closed */ } });
  });

  // ------------------------------------------------------------------- messages
  app.get('/api/team-runs/:id/messages', {
    schema: {
      tags: ['teams'], summary: 'Team conversation (filter by member, thread or type)',
      params: idParam,
      querystring: { type: 'object', properties: { memberId: { type: 'string' }, threadId: { type: 'string' }, type: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 1000 } } },
      response: { 404: errorSchema },
    },
  }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const run = store.getSystemRun(id);
    if (!run) return reply.code(404).send({ error: `team run not found: ${id}` });
    const q = req.query as { memberId?: string; threadId?: string; type?: string; limit?: number };
    const messages = store.listMessages(id, q);
    let roles = new Map<string, string>();
    try {
      const snapshot = JSON.parse(String(run.snapshot_json)) as { resolvedMembers?: { memberId: string; role: string }[] };
      roles = new Map((snapshot.resolvedMembers ?? []).map((m) => [m.memberId, m.role]));
    } catch { /* snapshot unreadable; ids are still useful */ }
    return { messages, markdown: renderConversation(messages, roles) };
  });

  app.post('/api/team-runs/:id/messages', {
    schema: {
      tags: ['teams'], summary: 'Send a message from the operator into the team conversation',
      params: idParam,
      body: {
        type: 'object', required: ['to', 'body'],
        properties: {
          to: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          body: { type: 'string', minLength: 1, maxLength: 20000 },
          type: { type: 'string', enum: MESSAGE_TYPES },
        },
      },
      response: { 400: errorSchema, 404: errorSchema },
    },
  }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const run = store.getSystemRun(id);
    if (!run) return reply.code(404).send({ error: `team run not found: ${id}` });
    const body = req.body as { to: string | string[]; body: string; type?: TeamMessageType };
    const targets = (Array.isArray(body.to) ? body.to : [body.to]).map(String).filter(Boolean);
    const messageId = store.addMessage({
      systemRunId: id, from: 'operator', to: targets, type: body.type ?? 'message', body: body.body,
    });
    store.appendEvent({ systemRunId: id, kind: 'message.operator', payload: { messageId, to: targets, type: body.type ?? 'message' } });
    return { ok: true, messageId };
  });

  // ------------------------------------------------------------------ artifacts
  app.get('/api/team-runs/:id/artifacts', { schema: { tags: ['teams'], summary: 'Deliverables published during the run', params: idParam, response: { 404: errorSchema } } }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!store.getSystemRun(id)) return reply.code(404).send({ error: `team run not found: ${id}` });
    return { artifacts: store.listArtifacts(id) };
  });

  app.get('/api/team-runs/:id/artifacts/:artifactId/content', {
    schema: { tags: ['teams'], summary: 'Download one deliverable', params: { type: 'object', properties: { id: { type: 'string' }, artifactId: { type: 'string' } }, required: ['id', 'artifactId'] }, response: { 404: errorSchema } },
  }, async (req, reply) => {
    const { artifactId } = req.params as { id: string; artifactId: string };
    const row = store.getArtifact(artifactId);
    if (!row?.path || !existsSync(row.path)) return reply.code(404).send({ error: 'artifact content not found on disk' });
    reply.header('content-disposition', `attachment; filename="${row.name}"`);
    reply.type('text/plain; charset=utf-8');
    return readFileSync(row.path);
  });

  // ------------------------------------------------------------------- handoffs
  app.get('/api/team-runs/:id/handoffs', { schema: { tags: ['teams'], summary: 'Handoff ledger (deliverables transferred between members)', params: idParam, response: { 404: errorSchema } } }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!store.getSystemRun(id)) return reply.code(404).send({ error: `team run not found: ${id}` });
    return { handoffs: store.listHandoffs(id) };
  });

  app.post('/api/team-runs/:id/handoffs/:handoffId', {
    schema: {
      tags: ['teams'], summary: 'Accept or reject a handoff as a human reviewer',
      params: { type: 'object', properties: { id: { type: 'string' }, handoffId: { type: 'string' } }, required: ['id', 'handoffId'] },
      body: { type: 'object', required: ['decision'], properties: { decision: { type: 'string', enum: ['accepted', 'rejected'] }, reason: { type: 'string', maxLength: 4000 } } },
      response: { 400: errorSchema, 404: errorSchema },
    },
  }, async (req, reply) => {
    const { id, handoffId } = req.params as { id: string; handoffId: string };
    const body = req.body as { decision: 'accepted' | 'rejected'; reason?: string };
    if (!store.decideHandoff(handoffId, body.decision, body.reason)) return reply.code(404).send({ error: `handoff not found: ${handoffId}` });
    store.appendEvent({ systemRunId: id, kind: 'handoff.decided', payload: { handoffId, decision: body.decision, by: 'operator', reason: body.reason } });
    return { ok: true };
  });

  // -------------------------------------------------------------------- exports
  app.get('/api/team-runs/:id/export', { schema: { tags: ['teams'], summary: 'Download the complete run bundle (snapshot, nodes, messages, artifacts, events)', params: idParam, response: { 404: errorSchema } } }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const bundle = teams.exportRun(id);
    if (!bundle) return reply.code(404).send({ error: `team run not found: ${id}` });
    reply.header('content-disposition', `attachment; filename="team-run-${id}.json"`);
    return bundle;
  });
}
