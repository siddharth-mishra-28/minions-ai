import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SqliteAdapter } from '../src/store/sqlite.js';
import { TeamStore } from '../src/store/teams.js';
import { TeamEngine } from '../src/execution/team/engine.js';
import { TeamService } from '../src/systems/service.js';
import { createScriptedExecutor, type MemberTurnRequest } from '../src/execution/team/executor.js';
import type { AgentSystemRunSnapshot } from '../src/systems/types.js';
import {
  agentDefinition, approvalTeam, hashOf, jsonBlock, managerTeam, registerAgent,
  sequentialTeam, tempWorkspace,
} from './team-fixtures.js';

const cleanups: string[] = [];

afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows lag */ }
  }
});

function stack(script: (req: MemberTurnRequest, call: number) => { text: string; fail?: string } | Promise<{ text: string; fail?: string }>) {
  const dir = tempWorkspace();
  cleanups.push(dir);
  const db = new SqliteAdapter(join(dir, 'teams.db'));
  const store = new TeamStore(db);
  const engine = new TeamEngine({ store, executor: createScriptedExecutor(script), lookup: db, workspaceRoot: dir });
  const service = new TeamService({ db, store, engine, workspaceRoot: dir });
  return { dir, db, store, engine, service };
}

const analyst = (db: SqliteAdapter) => registerAgent(db, 'analyst');
const developer = (db: SqliteAdapter) => registerAgent(db, 'developer');
const qa = (db: SqliteAdapter) => registerAgent(db, 'qa');
const manager = (db: SqliteAdapter) => registerAgent(db, 'manager');
const productOwner = (db: SqliteAdapter) => registerAgent(db, 'product-owner');

async function waitFor(store: TeamStore, runId: string, predicate: (status: string) => boolean, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = store.getSystemRun(runId);
    const status = String(run?.status ?? 'missing');
    if (predicate(status)) return status;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${runId}; status=${status}; events=${JSON.stringify(store.listEvents(runId).slice(-6))}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

function finalStatus(store: TeamStore, runId: string) {
  return waitFor(store, runId, (s) => ['done', 'failed', 'stopped'].includes(s));
}

function members(db: SqliteAdapter) {
  return {
    analyst: { memberId: 'analyst', role: 'Requirements Analyst', ...analyst(db) },
    developer: { memberId: 'developer', role: 'Software Developer', ...developer(db) },
    qa: { memberId: 'qa', role: 'QA Engineer', ...qa(db) },
    manager: { memberId: 'manager', role: 'Engineering Manager', ...manager(db) },
    po: { memberId: 'product-owner', role: 'Product Owner', ...productOwner(db) },
  };
}

describe('team engine — sequential pipeline', () => {
  it('runs every stage, publishes artifacts and accepts handoffs', async () => {
    const s = stack((req) => {
      if (req.memberId === 'analyst') return { text: jsonBlock({ status: 'done', summary: 'requirements complete', artifacts: [{ type: 'requirements-document', name: 'requirements.md', content: '# Requirements\nOAuth login' }] }) };
      if (req.memberId === 'developer') return { text: jsonBlock({ status: 'done', summary: 'implemented', artifacts: [{ type: 'implementation-report', name: 'implementation.json', content: '{"files":3}' }] }) };
      return { text: jsonBlock({ status: 'passed', summary: 'all tests pass' }) };
    });
    const m = members(s.db);
    const def = sequentialTeam([m.analyst, m.developer, m.qa]);
    const created = s.service.create(def);
    s.service.publish(created.id as string);
    const started = s.service.startRun('delivery-team', { task: 'Ship the login feature' });
    const status = await finalStatus(s.store, started.runId as string);
    expect(status).toBe('done');

    const runId = started.runId as string;
    const nodes = s.store.listNodeRuns(runId);
    expect(nodes.map((n) => n.node_id)).toEqual(['analysis', 'build', 'review']);
    expect(nodes.every((n) => n.status === 'done')).toBe(true);

    const artifacts = s.store.listArtifacts(runId);
    expect(artifacts.map((a) => a.name).sort()).toEqual(['implementation.json', 'requirements.md']);
    expect(artifacts.find((a) => a.name === 'requirements.md')?.content_hash).toMatch(/^sha256:/);

    const handoffs = s.store.listHandoffs(runId);
    expect(handoffs).toHaveLength(2);
    expect(handoffs.every((h) => h.status === 'accepted')).toBe(true);
    expect(handoffs.map((h) => `${h.from_member}->${h.to_member}`)).toEqual(['analyst->developer', 'developer->qa']);

    const snapshot = JSON.parse(String(s.store.getSystemRun(runId)!.snapshot_json)) as AgentSystemRunSnapshot;
    expect(snapshot.resolvedMembers.map((x) => x.memberId)).toEqual(['analyst', 'developer', 'qa']);
    expect(snapshot.workflowDefinitionHash).toMatch(/^sha256:/);
    expect(s.store.listRunSessions(runId)).toHaveLength(3);
  });

  it('sends failed reviews back through the rework loop until QA passes', async () => {
    let qaCalls = 0;
    const s = stack((req) => {
      if (req.memberId === 'analyst') return { text: jsonBlock({ status: 'done', artifacts: [{ type: 'requirements-document', name: 'requirements.md', content: '# R' }] }) };
      if (req.memberId === 'developer') return { text: jsonBlock({ status: 'done', summary: 'round done' }) };
      qaCalls += 1;
      return { text: jsonBlock({ status: qaCalls === 1 ? 'failed' : 'passed', summary: qaCalls === 1 ? 'two defects' : 'green' }) };
    });
    const m = members(s.db);
    const created = s.service.create(sequentialTeam([m.analyst, m.developer, m.qa]));
    s.service.publish(created.id as string);
    const started = s.service.startRun('delivery-team', { task: 'Rework the login feature' });
    expect(await finalStatus(s.store, started.runId as string)).toBe('done');
    const nodes = s.store.listNodeRuns(started.runId as string);
    expect(nodes.filter((n) => n.node_id === 'build')).toHaveLength(2);
    expect(nodes.filter((n) => n.node_id === 'review')).toHaveLength(2);
    expect(qaCalls).toBe(2);
    expect(s.store.listEvents(started.runId as string).some((e) => e.kind === 'edge.fire' && e.payload.label === undefined && e.payload.to === 'build')).toBe(true);
  });

  it('blocks a node whose output contract is unmet and fails the stalled run', async () => {
    const s = stack((req) => req.memberId === 'analyst'
      ? { text: jsonBlock({ status: 'done', summary: 'forgot the document' }) }
      : { text: jsonBlock({ status: 'done' }) });
    const m = members(s.db);
    const def = sequentialTeam([m.analyst, m.developer, m.qa]) as { orchestration: { workflows: { edges: Record<string, unknown>[] }[] } };
    def.orchestration.workflows[0].edges = [
      { from: 'analysis', to: 'build', when: { path: 'output.status', operator: 'equals', value: 'done' } },
      { from: 'build', to: 'review' },
      { from: 'review', to: 'done', when: { path: 'output.status', operator: 'equals', value: 'passed' } },
      { from: 'review', to: 'build', when: { path: 'output.status', operator: 'equals', value: 'failed' } },
    ];
    const created = s.service.create(def);
    s.service.publish(created.id as string);
    const started = s.service.startRun('delivery-team', { task: 'Contract test' });
    expect(await finalStatus(s.store, started.runId as string)).toBe('failed');
    const event = s.store.listEvents(started.runId as string).find((e) => e.kind === 'contract.missing');
    expect(event).toBeTruthy();
    expect(JSON.stringify(event?.payload)).toContain('requirements-document');
    expect(String(s.store.getSystemRun(started.runId as string)!.error)).toContain('no transition matched');
  });
});

describe('team engine — hierarchical manager', () => {
  it('delegates work, reviews the results and completes', async () => {
    const s = stack((req, call) => {
      if (req.memberId === 'manager') {
        if (call === 1) {
          return { text: jsonBlock({ status: 'in-progress', summary: 'plan ready', tasks: [
            { memberId: 'developer', title: 'API layer', task: 'Implement the API', dependsOn: [] },
            { memberId: 'qa', title: 'Test plan', task: 'Write the test plan', dependsOn: [] },
          ] }) };
        }
        return { text: jsonBlock({ status: 'complete', summary: 'reviewed and accepted' }) };
      }
      return { text: jsonBlock({ status: 'done', summary: `${req.memberId} delivered` }) };
    });
    const m = members(s.db);
    const created = s.service.create(managerTeam([m.manager, m.developer, m.qa]));
    s.service.publish(created.id as string);
    const started = s.service.startRun('agile-team', { task: 'Deliver the billing service' });
    expect(await finalStatus(s.store, started.runId as string)).toBe('done');

    const runId = started.runId as string;
    const nodes = s.store.listNodeRuns(runId);
    expect(nodes.filter((n) => n.node_id === 'manager').length).toBeGreaterThanOrEqual(2);
    expect(nodes.some((n) => n.member_id === 'developer')).toBe(true);
    expect(nodes.some((n) => n.member_id === 'qa')).toBe(true);
    const requests = s.store.listMessages(runId, { type: 'task-request' });
    expect(requests).toHaveLength(2);
    expect(requests.map((r) => r.to_members).flat().sort()).toEqual(['developer', 'qa']);
  });

  it('adds a requested specialist to the run only, never the published team', async () => {
    const s = stack((req, call) => {
      if (req.memberId === 'manager') {
        if (call === 1) {
          return { text: jsonBlock({ status: 'in-progress', addMembers: [{ memberId: 'security', role: 'Security Architect', agentRef: { agentId: 'security@1.0.0', version: '1.0.0' } }], tasks: [{ memberId: 'security', title: 'Threat model', task: 'Model the threats' }] }) };
        }
        return { text: jsonBlock({ status: 'complete', summary: 'threat model reviewed' }) };
      }
      return { text: jsonBlock({ status: 'done', summary: 'threat model', artifacts: [{ type: 'threat-model', name: 'threat-model.md', content: '# Threats' }] }) };
    });
    registerAgent(s.db, 'security');
    const m = members(s.db);
    const created = s.service.create(managerTeam([m.manager, m.developer, m.qa], { allowDynamic: true }));
    s.service.publish(created.id as string);
    const started = s.service.startRun('agile-team', { task: 'Banking platform' });
    expect(await finalStatus(s.store, started.runId as string)).toBe('done');

    const runId = started.runId as string;
    const snapshot = JSON.parse(String(s.store.getSystemRun(runId)!.snapshot_json)) as AgentSystemRunSnapshot;
    expect(snapshot.resolvedMembers.map((x) => x.memberId)).not.toContain('security');
    expect(snapshot.addedMembers?.map((x) => x.memberId)).toContain('security');
    expect(s.store.listArtifacts(runId).map((a) => a.name)).toContain('threat-model.md');
    const published = s.service.get('agile-team') as { definition: { team: { members: { memberId: string }[] } } };
    expect(published.definition.team.members.map((x) => x.memberId)).not.toContain('security');
  });

  it('refuses delegation to a member outside the manager policy', async () => {
    const s = stack((req, call) => {
      if (req.memberId === 'manager') {
        if (call === 1) return { text: jsonBlock({ status: 'in-progress', tasks: [{ memberId: 'qa', title: 'QA', task: 'test' }] }) };
        return { text: jsonBlock({ status: 'complete', summary: 'done alone' }) };
      }
      return { text: jsonBlock({ status: 'done' }) };
    });
    const m = members(s.db);
    const def = managerTeam([{ ...m.manager, delegation: { enabled: true, allowedMemberIds: ['developer'], maxDepth: 2, maxConcurrentDelegates: 2 } }, m.developer, m.qa]);
    const created = s.service.create(def);
    s.service.publish(created.id as string);
    const started = s.service.startRun('agile-team', { task: 'Policy test' });
    // Every delegate was refused, and the manager then claimed completion without ever
    // delegating: nobody did the work, so the run must not report success.
    expect(await finalStatus(s.store, started.runId as string)).toBe('failed');
    expect(String(s.store.getSystemRun(started.runId as string)?.error)).toMatch(/delegat|transition/i);
    const rejected = s.store.listEvents(started.runId as string).find((e) => e.kind === 'delegation.rejected');
    expect(JSON.stringify(rejected?.payload)).toContain('not an allowed delegate');
    expect(s.store.listNodeRuns(started.runId as string).some((n) => n.member_id === 'qa')).toBe(false);
  });

  it('re-prompts a manager that answers without delegating, then runs the delegated work', async () => {
    const prompts: string[] = [];
    const s = stack((req, call) => {
      if (req.memberId === 'manager') {
        prompts.push(req.prompt);
        if (call === 1) return { text: jsonBlock({ status: 'complete', summary: 'looks delivered' }) };
        if (call === 2) return { text: jsonBlock({ status: 'in-progress', tasks: [{ memberId: 'developer', title: 'Ledger', task: 'Build the ledger' }] }) };
        return { text: jsonBlock({ status: 'complete', summary: 'reviewed and accepted' }) };
      }
      prompts.push(req.prompt);
      return { text: jsonBlock({ status: 'done', summary: `${req.memberId} delivered` }) };
    });
    const m = members(s.db);
    const created = s.service.create(managerTeam([m.manager, m.developer]));
    s.service.publish(created.id as string);
    const started = s.service.startRun('agile-team', { task: 'Deliver the ledger' });
    expect(await finalStatus(s.store, started.runId as string)).toBe('done');
    expect(s.store.listEvents(started.runId as string).some((e) => e.kind === 'delegation.nudge')).toBe(true);
    expect(s.store.listNodeRuns(started.runId as string).some((n) => n.member_id === 'developer')).toBe(true);
    expect(prompts.filter((p) => p.includes('No delegation was accepted')).length).toBe(1);
  });

  it('never reports a delivery when a failure status reaches the terminal node', async () => {
    const s = stack((req) => {
      if (req.memberId === 'manager') return { text: jsonBlock({ status: 'in-progress', tasks: [{ memberId: 'qa', title: 'QA', task: 'test' }] }) };
      return { text: jsonBlock({ status: 'blocked', summary: 'cannot verify' }) };
    });
    const m = members(s.db);
    // Terminal edge accepts any status so the guard, not the edge conditions, decides.
    const def = managerTeam([m.manager, m.qa]);
    (def.orchestration as { workflows: { edges: unknown[] }[] }).workflows[0].edges = [
      { from: 'manager', to: 'done' },
    ];
    const created = s.service.create(def);
    s.service.publish(created.id as string);
    const started = s.service.startRun('agile-team', { task: 'Guard test' });
    expect(await finalStatus(s.store, started.runId as string)).toBe('failed');
    expect(String(s.store.getSystemRun(started.runId as string)?.error)).toMatch(/terminal/i);
  });
});

describe('team engine — communication, approvals and recovery', () => {
  it('persists member messages and delivers them on the next turn', async () => {
    const seen: string[] = [];
    const s = stack((req) => {
      if (req.memberId === 'analyst') {
        return { text: jsonBlock({ status: 'done', artifacts: [{ type: 'requirements-document', name: 'requirements.md', content: '# R' }], replies: [{ to: 'qa', type: 'review-request', body: 'Please review the security requirements.' }] }) };
      }
      if (req.memberId === 'developer') return { text: jsonBlock({ status: 'done' }) };
      seen.push(req.prompt);
      return { text: jsonBlock({ status: 'passed' }) };
    });
    const m = members(s.db);
    const created = s.service.create(sequentialTeam([m.analyst, m.developer, m.qa]));
    s.service.publish(created.id as string);
    const started = s.service.startRun('delivery-team', { task: 'Messaging test' });
    expect(await finalStatus(s.store, started.runId as string)).toBe('done');
    const messages = s.store.listMessages(started.runId as string);
    expect(messages.some((msg) => msg.from_member === 'analyst' && msg.type === 'review-request')).toBe(true);
    expect(seen.join('\n')).toContain('Messages awaiting qa');
  });

  it('rejects peer messages when the workflow disables peer-to-peer', async () => {
    const s = stack((req) => req.memberId === 'analyst'
      ? { text: jsonBlock({ status: 'done', artifacts: [{ type: 'requirements-document', name: 'requirements.md', content: '# R' }], replies: [{ to: 'qa', body: 'a question' }] }) }
      : { text: jsonBlock({ status: 'passed' }) });
    const m = members(s.db);
    const created = s.service.create(sequentialTeam([m.analyst, m.developer, m.qa], { allowPeerToPeer: false }));
    s.service.publish(created.id as string);
    const started = s.service.startRun('delivery-team', { task: 'Policy test' });
    expect(await finalStatus(s.store, started.runId as string)).toBe('done');
    expect(s.store.listMessages(started.runId as string).filter((msg) => msg.from_member === 'analyst')).toHaveLength(0);
    expect(s.store.listEvents(started.runId as string).some((e) => e.kind === 'message.rejected')).toBe(true);
  });

  it('waits at a human-approval gate and continues on approval', async () => {
    const s = stack((req) => req.memberId === 'analyst'
      ? { text: jsonBlock({ status: 'done', summary: 'ready' }) }
      : { text: jsonBlock({ status: 'done' }) });
    const m = members(s.db);
    const created = s.service.create(approvalTeam([m.analyst, m.po]));
    s.service.publish(created.id as string);
    const started = s.service.startRun('approval-team', { task: 'Approve the release' });
    const runId = started.runId as string;
    await waitFor(s.store, runId, (status) => status === 'awaiting-approval');
    const events = s.store.listEvents(runId);
    expect(events.some((e) => e.kind === 'approval.requested')).toBe(true);
    s.service.approveNode(runId, 'signoff', 'approved', 'ship it');
    expect(await finalStatus(s.store, runId)).toBe('done');
    expect(s.store.listEvents(runId).some((e) => e.kind === 'approval.decision')).toBe(true);
  });

  it('resumes from the persisted frontier after an interruption', async () => {
    let failBuild = true;
    const s = stack((req) => {
      if (req.memberId === 'analyst') return { text: jsonBlock({ status: 'done', artifacts: [{ type: 'requirements-document', name: 'requirements.md', content: '# R' }] }) };
      if (req.memberId === 'developer' && failBuild) { failBuild = false; return { text: '', fail: 'provider reset mid-run' }; }
      if (req.memberId === 'developer') return { text: jsonBlock({ status: 'done', summary: 'retried build' }) };
      return { text: jsonBlock({ status: 'passed' }) };
    });
    const m = members(s.db);
    type EdgeShape = { workflowId: string; name: string; mode: string; entryNodeId: string; nodes: unknown[]; edges: unknown[] };
    const def = sequentialTeam([m.analyst, m.developer, m.qa]) as unknown as { orchestration: { workflows: EdgeShape[] } };
    def.orchestration.workflows[0].edges = [
      { from: 'analysis', to: 'build', when: { path: 'output.status', operator: 'equals', value: 'done' } },
      { from: 'build', to: 'review', when: { path: 'output.status', operator: 'equals', value: 'done' } },
      { from: 'review', to: 'done', when: { path: 'output.status', operator: 'equals', value: 'passed' } },
    ];
    const created = s.service.create(def);
    s.service.publish(created.id as string);
    const started = s.service.startRun('delivery-team', { task: 'Recovery test' });
    const runId = started.runId as string;
    expect(await finalStatus(s.store, runId)).toBe('failed');
    expect(s.store.listNodeRuns(runId).filter((n) => n.node_id === 'build').length).toBe(1);

    s.store.setRunStatus(runId, 'interrupted', 'simulated restart');
    s.store.appendEvent({ systemRunId: runId, kind: 'frontier', payload: { pending: ['build'] } });
    s.service.resume(runId);
    expect(await finalStatus(s.store, runId)).toBe('done');
    expect(s.store.listNodeRuns(runId).filter((n) => n.node_id === 'build')).toHaveLength(2);
    expect(s.store.listNodeRuns(runId).filter((n) => n.node_id === 'analysis')).toHaveLength(1);
  });

  it('closes node attempts orphaned by a crashed process when the run resumes', async () => {
    const s = stack(() => ({ text: jsonBlock({ status: 'done' }) }));
    const m = members(s.db);
    const created = s.service.create(sequentialTeam([m.analyst, m.developer, m.qa]));
    s.service.publish(created.id as string);
    const started = s.service.startRun('delivery-team', { task: 'Orphan ledger test' });
    const runId = started.runId as string;
    expect(await finalStatus(s.store, runId)).toBe('done');

    // A process killed mid-node leaves a row that still claims to be running. Resume
    // must close that attempt as interrupted instead of leaving a phantom in-progress
    // node in the ledger forever.
    const orphan = s.store.startNodeRun({ systemRunId: runId, nodeId: 'build', memberId: 'developer', attempt: 7, iteration: 7 });
    s.store.setRunStatus(runId, 'interrupted', 'simulated restart');
    s.service.resume(runId);
    expect(await finalStatus(s.store, runId)).toBe('done');
    const closed = s.store.listNodeRuns(runId).find((n) => n.id === orphan);
    expect(closed?.status).toBe('interrupted');
    expect(String(closed?.error)).toContain('superseded by the resumed attempt');
  });
});

describe('team engine — version pinning', () => {
  it('replays the pinned definition after the agent registry moves on', async () => {
    const s = stack((req) => ({ text: jsonBlock({ status: 'done', artifacts: [{ type: 'requirements-document', name: 'requirements.md', content: '# pinned' }] }) }));
    const m = members(s.db);
    const created = s.service.create(sequentialTeam([m.analyst, m.developer, m.qa]));
    s.service.publish(created.id as string);

    // Move the agent registry forward; the run must still execute the pinned bytes.
    const newer = agentDefinition('analyst', '1.1.0');
    s.db.saveAgent('analyst', '1.1.0', JSON.stringify(newer), hashOf(newer));
    s.db.saveAgent('analyst', '1.0.0', JSON.stringify({ ...newer, metadata: { ...(newer.metadata as object), description: 'mutated' } }), 'sha256:mutated');

    const started = s.service.startRun('delivery-team', { task: 'Pinned replay' });
    expect(await finalStatus(s.store, started.runId as string)).toBe('done');
    const snapshot = JSON.parse(String(s.store.getSystemRun(started.runId as string)!.snapshot_json)) as AgentSystemRunSnapshot;
    expect(snapshot.resolvedMembers[0].agentVersion).toBe('1.0.0');
    expect(JSON.parse(snapshot.resolvedMembers[0].definitionJson).metadata.description).toBe('analyst fixture');
  });
});

describe('team engine — workspace sharing', () => {
  it('gives each member its own directory by default and one shared repository on request', async () => {
    const seen = new Map<string, string>();

    // Default: isolated member workspaces under <run>/members/<id>.
    const isolated = stack((req) => {
      seen.set(`isolated:${req.memberId}`, req.workspaceRoot);
      return { text: jsonBlock({ status: 'done', artifacts: [{ type: 'requirements-document', name: 'requirements.md', content: '# req' }] }) };
    });
    const mi = members(isolated.db);
    isolated.service.create(sequentialTeam([mi.analyst, mi.developer, mi.qa]));
    isolated.service.publish('delivery-team');
    const first = isolated.service.startRun('delivery-team', { task: 'isolated' });
    expect(await finalStatus(isolated.store, first.runId as string)).toBe('done');
    expect(seen.get('isolated:developer')).toBe(join(String(isolated.store.getSystemRun(first.runId as string)!.workspace), 'members', 'developer'));

    // A delivery team that shares one repository: every member works at the run root.
    seen.clear();
    const shared = stack((req) => {
      seen.set(`shared:${req.memberId}`, req.workspaceRoot);
      return { text: jsonBlock({ status: 'done', artifacts: [{ type: 'requirements-document', name: 'requirements.md', content: '# req' }] }) };
    });
    const ms = members(shared.db);
    const def = sequentialTeam([ms.analyst, ms.developer, ms.qa]);
    for (const member of (def.team as { members: { workspace?: string }[] }).members) member.workspace = 'shared';
    shared.service.create(def);
    shared.service.publish('delivery-team');
    const second = shared.service.startRun('delivery-team', { task: 'shared' });
    expect(await finalStatus(shared.store, second.runId as string)).toBe('done');
    const runWorkspace = resolve(String(shared.store.getSystemRun(second.runId as string)!.workspace));
    for (const id of ['analyst', 'developer', 'qa']) {
      expect(seen.get(`shared:${id}`)).toBe(runWorkspace);
    }
    const sessions = shared.store.listRunSessions(second.runId as string);
    expect(sessions.every((s) => String(s.workspace ?? '') === runWorkspace)).toBe(true);
  });
});
