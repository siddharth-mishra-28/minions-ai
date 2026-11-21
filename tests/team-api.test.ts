import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScriptedExecutor } from '../src/execution/team/executor.js';
import {
  agentDefinition, hashOf, jsonBlock, sequentialTeam, tempWorkspace,
} from './team-fixtures.js';

/**
 * Team orchestration over HTTP. The SDK turn is replaced by a scripted executor, so
 * these tests exercise the real routes, store, engine, snapshot resolution and
 * persistence — everything except the model call itself.
 */
let dir: string;
let app: import('fastify').FastifyInstance;
let built: Awaited<ReturnType<typeof import('../src/server.js').buildServer>>;

const json = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) => {
  const res = await app.inject({ method, url, payload: payload as never });
  const ct = res.headers['content-type']?.toString() ?? '';
  return { status: res.statusCode, body: ct.includes('json') ? res.json() : res.body };
};

const waitFor = async <T>(fn: () => Promise<T>, done: (v: T) => boolean, ms = 8000): Promise<T> => {
  const t0 = Date.now();
  for (;;) {
    const value = await fn();
    if (done(value)) return value;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for run state: ${JSON.stringify(value).slice(0, 800)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

const seedAgent = (name: string, version = '1.0.0') => {
  const def = agentDefinition(name, version);
  const hash = hashOf(def);
  built.db.saveAgent(name, version, JSON.stringify(def), hash);
  return { agentId: `${name}@${version}`, version, definitionHash: hash };
};

function teamFor(names: string[], id = 'delivery-team') {
  // sequentialTeam() maps each spec through member(), so hand it plain specs.
  const m = (memberId: string, role: string, agentName: string) => ({ memberId, role, ...seedAgent(agentName) });
  const def = sequentialTeam([
    m('analyst', 'Requirements Analyst', 'analyst'),
    m('developer', 'Software Developer', 'developer'),
    m('qa', 'QA Engineer', 'qa'),
  ]);
  (def.metadata as Record<string, unknown>).id = id;
  (def.metadata as Record<string, unknown>).name = names.length ? 'Team API fixture' : 'Team API fixture';
  return def;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'team-api-'));
  process.env.MINION_WORKSPACE = join(dir, 'ws');
  const executor = createScriptedExecutor((req) => {
    if (req.memberId === 'analyst') {
      return { text: jsonBlock({ status: 'done', summary: 'requirements ready', artifacts: [{ type: 'requirements-document', name: 'requirements.md', content: '# Requirements\nSSO login' }] }) };
    }
    if (req.memberId === 'developer') {
      return { text: jsonBlock({ status: 'done', summary: 'implemented', artifacts: [{ type: 'implementation-report', name: 'implementation.json', content: '{"files":2}' }], replies: [{ to: 'qa', type: 'review-request', body: 'Please test the login flow.' }] }) };
    }
    return { text: jsonBlock({ status: 'passed', summary: 'all green' }) };
  });
  const { buildServer } = await import('../src/server.js');
  built = await buildServer(join(dir, 'team-api.db'), { teamExecutor: executor });
  app = built.app;
});

afterAll(async () => {
  try { await app.close(); } catch { /* noop */ }
  delete process.env.MINION_WORKSPACE;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows lag */ }
});

describe('team definitions over HTTP', () => {
  it('rejects an invalid team, then creates, validates and publishes a valid one', async () => {
    const bad = await json('POST', '/api/teams', { definition: { schemaVersion: '1.0', kind: 'agent-system' } });
    expect(bad.status).toBe(400);
    expect(String(bad.body.error)).toMatch(/Schema validation failed/i);

    const created = await json('POST', '/api/teams', { definition: teamFor([]) });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body.id).toBe('delivery-team');
    expect(created.body.currentVersion ?? null).toBeNull();
    expect(created.body.validation.ok).toBe(true);

    const dup = await json('POST', '/api/teams', { definition: teamFor([]) });
    expect(dup.status).toBe(409);

    const dry = await json('POST', '/api/teams/delivery-team/validate', { definition: { schemaVersion: '1.0' } });
    expect(dry.status).toBe(200);
    expect(dry.body.ok).toBe(false);
    expect(dry.body.errors.length).toBeGreaterThan(0);

    const published = await json('POST', '/api/teams/delivery-team/publish', {});
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    expect(published.body.currentVersion).toBe('1.0.0');
    expect(published.body.definitionHash).toMatch(/^sha256:/);

    const versions = await json('GET', '/api/teams/delivery-team/versions');
    expect(versions.body.versions.map((v: { version: string }) => v.version)).toContain('1.0.0');
    expect(versions.body.workflows.map((w: { workflow_id: string }) => w.workflow_id)).toEqual(['delivery']);

    const list = await json('GET', '/api/teams');
    const row = list.body.teams.find((t: { id: string }) => t.id === 'delivery-team');
    expect(row.members.map((m: { memberId: string }) => m.memberId)).toEqual(['analyst', 'developer', 'qa']);
    expect(row.workflows[0]).toMatchObject({ workflowId: 'delivery', mode: 'sequential' });

    const detail = await json('GET', '/api/teams/delivery-team');
    expect(detail.body.hasDraftChanges).toBe(false);
    expect(detail.body.versions).toHaveLength(1);
    expect((await json('GET', '/api/teams/nope')).status).toBe(404);
  });

  it('tracks draft changes without touching the published version', async () => {
    const def = teamFor([]);
    (def.metadata as Record<string, unknown>).description = 'edited draft';
    const updated = await json('PUT', '/api/teams/delivery-team', { definition: def });
    expect(updated.status).toBe(200);
    expect(updated.body.hasDraftChanges).toBe(true);
    expect(updated.body.currentVersion).toBe('1.0.0');
    const versions = await json('GET', '/api/teams/delivery-team/versions');
    expect(versions.body.versions[0].definition_hash).not.toBe(updated.body.definitionHash);
    expect(updated.body.definition.metadata.description).toBe('edited draft');

    const bad = await json('PUT', '/api/teams/delivery-team', { definition: { schemaVersion: '1.0' } });
    expect(bad.status).toBe(400);
    expect((await json('PUT', '/api/teams/ghost', { definition: teamFor([]) })).status).toBe(404);
  });
});

describe('team runs over HTTP', () => {
  let runId = '';

  it('refuses to run an unknown or unpublished team', async () => {
    expect((await json('POST', '/api/teams/nope/runs', { task: 'x' })).status).toBe(404);
    const draftOnly = { ...teamFor([]), metadata: { id: 'draft-team', name: 'Draft only', version: '1.0.0' } };
    expect((await json('POST', '/api/teams', { definition: draftOnly })).status).toBe(200);
    const r = await json('POST', '/api/teams/draft-team/runs', { task: 'x' });
    expect(r.status).toBe(409);
    expect(String(r.body.error)).toMatch(/publish/i);
  });

  it('starts a run pinned to the published version and completes it', async () => {
    const started = await json('POST', '/api/teams/delivery-team/runs', { task: 'Ship SSO' });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    runId = started.body.runId;
    expect(runId).toMatch(/^team_/);
    expect(started.body.workflowId).toBe('delivery');
    expect(started.body.version).toBe('1.0.0');

    const detail = await waitFor(
      async () => (await json('GET', `/api/team-runs/${runId}`)).body,
      (b) => ['done', 'failed', 'stopped'].includes(b.run.status),
    );
    expect(detail.run.status, JSON.stringify(detail.run.error)).toBe('done');
    expect(detail.run.system_id).toBe('delivery-team');
    expect(detail.run.system_version).toBe('1.0.0');
    expect(detail.snapshot.resolvedMembers.map((m: { memberId: string }) => m.memberId)).toEqual(['analyst', 'developer', 'qa']);
    expect(detail.snapshot.workflowDefinitionHash).toMatch(/^sha256:/);
    expect(detail.snapshot.limits.maxNodeRuns).toBeGreaterThan(0);
    expect(detail.nodes.map((n: { node_id: string }) => n.node_id)).toEqual(['analysis', 'build', 'review']);
    expect(detail.nodes.every((n: { status: string }) => n.status === 'done')).toBe(true);
    expect(detail.sessions).toHaveLength(3);
    expect(detail.artifacts.map((a: { name: string }) => a.name).sort()).toEqual(['implementation.json', 'requirements.md']);
    expect(detail.handoffs).toHaveLength(2);
    expect(detail.handoffs.every((h: { status: string }) => h.status === 'accepted')).toBe(true);
    expect(detail.messageCount).toBeGreaterThanOrEqual(1);
    expect(detail.progress.length).toBe(3);
    expect(detail.progress.every((p: { percent: number }) => p.percent === 100)).toBe(true);
    expect(detail.active).toBe(false);
  });

  it('exposes per-member progress and the append-only event timeline plus the operator chat channel', async () => {
    const progress = await json('GET', `/api/team-runs/${runId}/progress`);
    expect(progress.status).toBe(200);
    expect(progress.body.runId).toBe(runId);
    expect(progress.body.items.map((p: { member_id: string }) => p.member_id).sort()).toEqual(['analyst', 'developer', 'qa']);
    expect(progress.body.byStatus.done).toBe(3);
    expect(progress.body.updatedAt).toMatch(/T/);
    const events = await json('GET', `/api/team-runs/${runId}/events`);
    expect(events.status).toBe(200);
    const kinds = events.body.events.map((e: { kind: string }) => e.kind);
    for (const needed of ['run.queued', 'run.start', 'node.start', 'node.end', 'edge.fire', 'run.complete']) {
      expect(kinds, `missing ${needed}: ${kinds.join(',')}`).toContain(needed);
    }
    expect(events.body.lastSeq).toBe(events.body.events.at(-1).seq);
    const after = await json('GET', `/api/team-runs/${runId}/events?after=${events.body.lastSeq}`);
    expect(after.body.events).toHaveLength(0);

    const convo = await json('GET', `/api/team-runs/${runId}/messages`);
    expect(convo.status).toBe(200);
    expect(convo.body.markdown).toContain('QA Engineer');
    expect(convo.body.messages.some((m: { type: string }) => m.type === 'review-request')).toBe(true);
    const fromDev = await json('GET', `/api/team-runs/${runId}/messages?memberId=developer`);
    // The member filter is bidirectional: it includes messages developer sent and
    // messages addressed to developer (including the sequential handoff from analyst).
    expect(fromDev.body.messages.every((m: { from_member: string; to_members: string[] }) => m.from_member === 'developer' || m.to_members.includes('developer'))).toBe(true);
    expect(fromDev.body.messages.some((m: { from_member: string }) => m.from_member === 'developer')).toBe(true);

    const sent = await json('POST', `/api/team-runs/${runId}/messages`, { to: ['qa'], body: 'Please double-check the SSO edge cases.', type: 'clarification' });
    expect(sent.status).toBe(200);
    const after2 = await json('GET', `/api/team-runs/${runId}/messages`);
    const operator = after2.body.messages.find((m: { id: string }) => m.id === sent.body.messageId);
    expect(operator).toMatchObject({ from_member: 'operator', type: 'clarification' });
    expect(operator.to_members).toEqual(['qa']);
    expect((await json('POST', `/api/team-runs/${runId}/messages`, { to: 'qa', body: '' })).status).toBe(400);
  });

  it('serves artifacts, records handoff decisions and exports the whole bundle', async () => {
    const artifacts = await json('GET', `/api/team-runs/${runId}/artifacts`);
    const requirements = artifacts.body.artifacts.find((a: { name: string }) => a.name === 'requirements.md');
    expect(requirements.content_hash).toMatch(/^sha256:/);
    const content = await json('GET', `/api/team-runs/${runId}/artifacts/${requirements.id}/content`);
    expect(content.status).toBe(200);
    expect(String(content.body)).toContain('SSO login');

    const handoffs = (await json('GET', `/api/team-runs/${runId}/handoffs`)).body.handoffs;
    const decided = await json('POST', `/api/team-runs/${runId}/handoffs/${handoffs[0].id}`, { decision: 'accepted', reason: 'looks good' });
    expect(decided.status).toBe(200);
    expect((await json('POST', `/api/team-runs/${runId}/handoffs/nope`, { decision: 'accepted' })).status).toBe(404);
    const events = await json('GET', `/api/team-runs/${runId}/events`);
    expect(events.body.events.some((e: { kind: string; payload: { by?: string } }) => e.kind === 'handoff.decided' && e.payload.by === 'operator')).toBe(true);

    const bundle = await json('GET', `/api/team-runs/${runId}/export`);
    expect(bundle.status).toBe(200);
    expect(bundle.body.run.id).toBe(runId);
    expect(bundle.body.nodes).toHaveLength(3);
    expect(bundle.body.messages.length).toBeGreaterThan(0);
    expect(bundle.body.artifacts).toHaveLength(2);
    expect(bundle.body.progress).toHaveLength(3);
    expect(bundle.body.events.length).toBeGreaterThan(5);

    const runs = await json('GET', '/api/team-runs?systemId=delivery-team&status=done');
    expect(runs.body.runs.some((r: { id: string }) => r.id === runId)).toBe(true);
  });

  it('404s unknown runs and stops a finished run without touching its history', async () => {
    for (const url of ['/api/team-runs/nope', '/api/team-runs/nope/events', '/api/team-runs/nope/messages', '/api/team-runs/nope/progress', '/api/team-runs/nope/artifacts', '/api/team-runs/nope/export']) {
      expect((await json('GET', url)).status, url).toBe(404);
    }
    const stopped = await json('POST', `/api/team-runs/${runId}/stop`);
    expect(stopped.status).toBe(200);
    const resume = await json('POST', `/api/team-runs/${runId}/resume`);
    expect(resume.status).toBe(409);
    const gate = await json('POST', `/api/team-runs/${runId}/nodes/signoff/approval`, { decision: 'approved' });
    expect(gate.status).toBe(409);
    expect((await json('POST', '/api/team-runs/nope/stop')).status).toBe(404);
  });

  it('deletes a team only when it has no run history', async () => {
    const del = await json('DELETE', '/api/teams/delivery-team');
    expect(del.status).toBe(409);
    expect(String(del.body.error)).toMatch(/run history/i);
    expect((await json('DELETE', '/api/teams/draft-team')).status).toBe(200);
    expect((await json('GET', '/api/teams/draft-team')).status).toBe(404);
  });
});

describe('team workspace confinement', () => {
  it('rejects a workspace outside the server workspace', async () => {
    const outside = tempWorkspace('outside-');
    try {
      const r = await json('POST', '/api/teams/delivery-team/runs', { task: 'x', workspace: outside });
      expect(r.status).toBe(400);
      expect(String(r.body.error)).toMatch(/inside the server workspace/i);
    } finally {
      try { rmSync(outside, { recursive: true, force: true }); } catch { /* lag */ }
    }
  });
});
