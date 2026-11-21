import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScriptedExecutor } from '../src/execution/team/executor.js';
import { agentDefinition, hashOf, jsonBlock, sequentialTeam } from './team-fixtures.js';

let dir: string;
let app: import('fastify').FastifyInstance;
let built: Awaited<ReturnType<typeof import('../src/server.js').buildServer>>;
let teamId = 'a2a-team';

const inject = async (method: 'GET' | 'POST', url: string, payload?: unknown, headers: Record<string, string> = {}) => {
  const res = await app.inject({ method, url, payload: payload as never, headers });
  return { status: res.statusCode, body: res.body, json: () => res.json() as Record<string, unknown> };
};

const rpc = async (method: string, params: Record<string, unknown>, headers: Record<string, string> = {}, url = `/a2a/${teamId}`) =>
  inject('POST', url, { jsonrpc: '2.0', id: 'test-1', method, params }, headers);

function seedAgent(name: string) {
  const def = agentDefinition(name);
  const hash = hashOf(def);
  built.db.saveAgent(name, '1.0.0', JSON.stringify(def), hash);
  return { memberId: name, role: name, agentId: `${name}@1.0.0`, version: '1.0.0', definitionHash: hash };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'a2a-test-'));
  process.env.MINION_WORKSPACE = join(dir, 'ws');
  const executor = createScriptedExecutor((req) => {
    if (req.memberId === 'analyst') {
      return { text: jsonBlock({ status: 'done', summary: 'requirements ready', progress: { percent: 100, phase: 'analysis' }, artifacts: [{ type: 'requirements-document', name: 'requirements.md', content: '# A2A requirements' }] }) };
    }
    if (req.memberId === 'developer') {
      return { text: jsonBlock({ status: 'done', summary: 'implemented', progress: { percent: 100, phase: 'build' } }) };
    }
    return { text: jsonBlock({ status: 'passed', summary: 'all green' }) };
  });
  const { buildServer } = await import('../src/server.js');
  built = await buildServer(join(dir, 'a2a.db'), { teamExecutor: executor });
  app = built.app;

  const members = [seedAgent('analyst'), seedAgent('developer'), seedAgent('qa')];
  const def = sequentialTeam(members);
  (def.metadata as Record<string, unknown>).id = teamId;
  (def.metadata as Record<string, unknown>).name = 'A2A Team';
  const created = await inject('POST', '/api/teams', { definition: def });
  expect(created.status).toBe(200);
  const published = await inject('POST', `/api/teams/${teamId}/publish`, { version: '1.0.0' });
  expect(published.status).toBe(200);
});

afterAll(async () => {
  delete process.env.A2A_TOKEN;
  try { await app.close(); } catch { /* noop */ }
  delete process.env.MINION_WORKSPACE;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows lag */ }
});

describe('A2A discovery', () => {
  it('serves platform, team and member agent cards', async () => {
    const platform = await inject('GET', '/.well-known/agent-card.json');
    expect(platform.status).toBe(200);
    const platformBody = platform.json() as { protocolVersion: string; skills: { id: string }[] };
    expect(platformBody.protocolVersion).toBe('0.3.0');
    expect(platformBody.skills.some((s) => s.id === teamId)).toBe(true);

    const team = await inject('GET', `/a2a/${teamId}/.well-known/agent-card.json`);
    expect(team.status).toBe(200);
    const teamBody = team.json() as { name: string; capabilities: { streaming: boolean }; metadata: { members: { memberId: string }[] } };
    expect(teamBody.name).toBe('A2A Team');
    expect(teamBody.capabilities.streaming).toBe(true);
    expect(teamBody.metadata.members).toHaveLength(3);

    const member = await inject('GET', `/a2a/${teamId}/members/analyst/.well-known/agent-card.json`);
    expect(member.status).toBe(200);
    expect((member.json() as { metadata: { memberId: string } }).metadata.memberId).toBe('analyst');

    expect((await inject('GET', '/a2a/nope/.well-known/agent-card.json')).status).toBe(404);
    expect((await inject('GET', `/a2a/${teamId}/members/nobody/.well-known/agent-card.json`)).status).toBe(404);
  });
});

describe('A2A JSON-RPC', () => {
  it('starts a run with message/send, exposes it as a Task, and completes it', async () => {
    const send = await rpc('message/send', {
      message: {
        kind: 'message', messageId: 'msg-start-1', role: 'user', parts: [{ kind: 'text', text: 'Build the SSO demo.' }],
      },
    });
    expect(send.status).toBe(200);
    const body = send.json() as { result: { kind: string; id: string; status: { state: string } } };
    expect(body.result.kind).toBe('task');
    expect(body.result.status.state).toBe('submitted');
    const taskId = body.result.id;

    let task: { status: { state: string }; artifacts: unknown[]; history: unknown[]; metadata: { progress: unknown[] } } | undefined;
    for (let i = 0; i < 120; i++) {
      const got = await rpc('tasks/get', { id: taskId });
      expect(got.status).toBe(200);
      task = (got.json() as { result: typeof task }).result;
      if (task && ['completed', 'failed', 'canceled'].includes(task.status.state)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(task?.status.state).toBe('completed');
    expect(task?.artifacts.length).toBeGreaterThanOrEqual(1);
    expect(task?.history.length).toBeGreaterThanOrEqual(2);
    expect(task?.metadata.progress.length).toBeGreaterThanOrEqual(3);

    const rest = await inject('GET', `/a2a/${teamId}/tasks/${taskId}`);
    expect(rest.status).toBe(200);
    expect((rest.json() as { kind: string }).kind).toBe('task');
  });

  it('is idempotent for a repeated messageId on an existing task', async () => {
    const started = await rpc('message/send', {
      message: { kind: 'message', messageId: 'msg-existing-1', role: 'user', parts: [{ kind: 'text', text: 'Add acceptance evidence.' }] },
    });
    const taskId = (started.json() as { result: { id: string } }).result.id;
    for (let i = 0; i < 120; i++) {
      const got = await rpc('tasks/get', { id: taskId });
      const t = (got.json() as { result: { status: { state: string } } }).result;
      if (['completed', 'failed'].includes(t.status.state)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const before = await rpc('tasks/get', { id: taskId });
    const historyBefore = (before.json() as { result: { history: unknown[] } }).result.history.length;
    const repeated = await rpc('message/send', {
      message: { kind: 'message', messageId: 'msg-existing-1', role: 'user', contextId: taskId, parts: [{ kind: 'text', text: 'Add acceptance evidence.' }] },
    });
    // The task is already terminal: the retry is rejected without duplicating history.
    expect(repeated.status).toBe(200);
    const err = repeated.json() as { error?: { code: number }; result?: unknown };
    expect(err.error?.code).toBeDefined();
    const after = await rpc('tasks/get', { id: taskId });
    expect((after.json() as { result: { history: unknown[] } }).result.history.length).toBe(historyBefore);
  });

  it('rejects unknown methods and unknown tasks with JSON-RPC errors', async () => {
    const unknown = await rpc('message/nope', {});
    expect((unknown.json() as { error: { code: number } }).error.code).toBe(-32601);
    const missing = await rpc('tasks/get', { id: 'team_nope' });
    expect((missing.json() as { error: { code: number } }).error.code).toBe(-32001);
  });

  it('streams task updates as SSE and ends with a final event', async () => {
    const res = await inject('POST', `/a2a/${teamId}`, {
      jsonrpc: '2.0', id: 'stream-1', method: 'message/stream',
      params: { message: { kind: 'message', messageId: 'msg-stream-1', role: 'user', parts: [{ kind: 'text', text: 'Stream a short run.' }] } },
    });
    expect(res.status).toBe(200);
    const frames = res.body.split('\n\n').filter((f) => f.includes('data: '));
    expect(frames.length).toBeGreaterThanOrEqual(2);
    const payloads = frames.map((f) => JSON.parse(f.slice(f.indexOf('data: ') + 6)) as { result: { kind: string; final?: boolean } });
    expect(payloads[0].result.kind).toBe('task');
    expect(payloads.at(-1)?.result.final).toBe(true);
  });

  it('enforces the bearer token when A2A_TOKEN is set, while cards stay discoverable', async () => {
    process.env.A2A_TOKEN = 'test-secret';
    try {
      expect((await inject('GET', `/.well-known/agent-card.json`)).status).toBe(200);
      const denied = await rpc('tasks/list', {});
      expect(denied.status).toBe(401);
      const allowed = await rpc('tasks/list', {}, { authorization: 'Bearer test-secret' });
      expect(allowed.status).toBe(200);
      expect(Array.isArray((allowed.json() as { result: { tasks: unknown[] } }).result.tasks)).toBe(true);
    } finally {
      delete process.env.A2A_TOKEN;
    }
  });
});
