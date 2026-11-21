import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAgentAuthorTools, buildTeamAuthorTools } from '../src/agents/author-tools.js';
import { buildAgentAuthor, buildTeamAuthor, AGENT_AUTHOR_ID, TEAM_AUTHOR_ID } from '../src/agents/author-agents.js';
import { validateDefinitionObject } from '../src/agents/loader.js';
import { TeamStore } from '../src/store/teams.js';
import { TeamService } from '../src/systems/service.js';

/**
 * The builtin chat designers' platform tools: validate/save against the real
 * schema and registry (the same code path as POST /api/agents and
 * TeamService.create/publish). No model is involved — the tools are pure
 * handlers, which is exactly what a chat turn calls.
 */

let dir: string;
let ctx: Parameters<typeof buildAgentAuthorTools>[0];
let teams: TeamService;
let teamStore: TeamStore;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'author-tools-'));
  const { buildServer } = await import('../src/server.js');
  const built = await buildServer(join(dir, 't.db'));
  teamStore = new TeamStore(built.db);
  teams = new TeamService({ db: built.db, store: teamStore, engine: {} as never, workspaceRoot: dir });
  ctx = { db: built.db, platform: built.platform, teams: () => teams };
  (ctx as { app?: unknown }).app = built.app;
});

afterAll(async () => {
  const app = (ctx as { app?: { close: () => Promise<void> } }).app;
  try { await app?.close(); } catch { /* noop */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows lag */ }
});

const minimalAgent = (name: string) => ({
  schemaVersion: '1.0',
  metadata: { name, version: '1.0.0', description: 'test agent' },
  task: { prompt: 'say hi' },
  tools: { builtins: { all: true, default: 'allow' } },
  provider: { type: 'openai', baseUrl: 'https://never-called.invalid/v1', model: 'm', wireApi: 'completions', providerApiKey: 'k' },
});

const handler = (tools: { name: string; handler: (a: Record<string, unknown>) => Promise<unknown> }[], name: string) => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} missing`);
  return async (args: Record<string, unknown> = {}) => JSON.parse(await t.handler(args) as string) as Record<string, unknown>;
};

describe('agent authoring tools', () => {
  it('exposes the expected tool surface with JSON-schema parameters', () => {
    const tools = buildAgentAuthorTools(ctx);
    expect(tools.map((t) => t.name).sort()).toEqual([
      'list_builtin_tools', 'list_mcp_servers', 'list_registered_agents', 'save_agent_definition', 'validate_agent_definition',
    ]);
    for (const t of tools) expect(t.parameters.type).toBe('object');
  });

  it('validate_agent_definition accepts a schema-valid definition and rejects a broken one', async () => {
    const validate = handler(buildAgentAuthorTools(ctx), 'validate_agent_definition');
    const good = await validate({ definition: minimalAgent('valid-agent') });
    expect(good.valid).toBe(true);
    expect(String(good.hash)).toMatch(/^[0-9a-f]{16}$/);
    const bad = await validate({ definition: { schemaVersion: '1.0' } });
    expect(bad.valid).toBe(false);
    expect(String(bad.error)).toMatch(/Schema|required/i);
  });

  it('save_agent_definition registers under the chosen name exactly like POST /api/agents', async () => {
    const tools = buildAgentAuthorTools(ctx);
    const save = handler(tools, 'save_agent_definition');
    const saved = await save({ definition: minimalAgent('ignored'), name: 'designed-agent', version: '1.0.0' });
    expect(saved.id).toBe('designed-agent@1.0.0');
    const row = ctx.db.getAgent('designed-agent@1.0.0') as { definition_hash: string } | undefined;
    expect(row).toBeTruthy();
    expect(String(row!.definition_hash)).toBe(String(saved.hash));
    // The saved definition is the sealed, schema-valid form.
    const load = validateDefinitionObject(JSON.parse(String((ctx.db.getAgent('designed-agent@1.0.0') as { definition_json: string }).definition_json)));
    expect(load.definition.metadata.name).toBe('designed-agent');
    // Discovery sees it.
    const list = await handler(tools, 'list_registered_agents')();
    expect((list.agents as { id: string }[]).some((a) => a.id === 'designed-agent@1.0.0')).toBe(true);
  });

  it('save_agent_definition rejects an invalid definition without touching the registry', async () => {
    const before = (ctx.db.listAgents('all')).length;
    const save = handler(buildAgentAuthorTools(ctx), 'save_agent_definition');
    const out = await save({ definition: { nope: true } });
    expect(out.valid).toBe(false);
    expect((ctx.db.listAgents('all')).length).toBe(before);
  });
});

describe('team authoring tools', () => {
  it('exposes the expected tool surface', () => {
    const names = buildTeamAuthorTools(ctx).map((t) => t.name).sort();
    expect(names).toEqual(['list_builtin_tools', 'list_mcp_servers', 'list_registered_agents', 'save_agent_system', 'validate_agent_system']);
  });

  it('save_agent_system validates member pins, creates and publishes a team', async () => {
    const tools = buildTeamAuthorTools(ctx);
    const save = handler(tools, 'save_agent_system');
    // The agent saved by the previous test is the member.
    const definition = {
      schemaVersion: '1.0', kind: 'agent-system',
      metadata: { id: 'designed-team', name: 'Designed Team', version: '1.0.0' },
      team: { members: [{ memberId: 'worker', role: 'Worker', agentRef: { agentId: 'designed-agent@1.0.0', version: '1.0.0', definitionHash: 'sha256:0000000000000000' } }] },
      orchestration: {
        defaultWorkflowId: 'pipeline',
        workflows: [{
          workflowId: 'pipeline', name: 'Pipeline', mode: 'sequential', version: '1.0.0', entryNodeId: 'work',
          nodes: [{ nodeId: 'work', type: 'agent-task', memberId: 'worker' }, { nodeId: 'done', type: 'terminal' }],
          edges: [{ from: 'work', to: 'done' }],
        }],
      },
    };
    const out = await save({ definition });
    expect(out.published).toBe(true);
    expect(out.id).toBe('designed-team');
    expect(out.version).toBe('1.0.0');
    const published = teamStore.getSystemVersion('designed-team', '1.0.0');
    expect(published).toBeTruthy();
    // create/update pins members to the registered definition (pinMembersToRegistry).
    const pinned = (JSON.parse(published!.definitionJson) as { team: { members: { agentRef: { definitionHash: string } }[] } }).team.members[0].agentRef.definitionHash;
    const row = ctx.db.getAgent('designed-agent@1.0.0') as { definition_hash: string };
    expect(pinned).toBe(`sha256:${row.definition_hash}`);
  });

  it('validate_agent_system flags unknown member pins', async () => {
    const validate = handler(buildTeamAuthorTools(ctx), 'validate_agent_system');
    const out = await validate({ definition: {
      schemaVersion: '1.0', kind: 'agent-system',
      metadata: { id: 'broken-team', name: 'Broken', version: '1.0.0' },
      team: { members: [{ memberId: 'ghost', role: 'Ghost', agentRef: { agentId: 'never-registered@1.0.0', version: '1.0.0' } }] },
      orchestration: { defaultWorkflowId: 'w', workflows: [{ workflowId: 'w', name: 'W', mode: 'sequential', entryNodeId: 'a', nodes: [{ nodeId: 'a', type: 'agent-task', memberId: 'ghost' }, { nodeId: 'z', type: 'terminal' }], edges: [{ from: 'a', to: 'z' }] }] },
    } });
    expect(out.valid).toBe(false);
  });
});

describe('POST /api/agents/:id/clone', () => {
  it('clones a registered agent under a new name and refuses duplicates', async () => {
    const app = (ctx as { app?: { inject: (o: unknown) => Promise<{ statusCode: number; json: () => Record<string, unknown> }> } }).app!;
    const res = await app.inject({ method: 'POST', url: '/api/agents/designed-agent@1.0.0/clone', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe('designed-agent-clone@1.0.0');
    expect(ctx.db.getAgent('designed-agent-clone@1.0.0')).toBeTruthy();
    const again = await app.inject({ method: 'POST', url: '/api/agents/designed-agent@1.0.0/clone', payload: {} });
    expect(again.statusCode).toBe(409);
    const missing = await app.inject({ method: 'POST', url: '/api/agents/nope@0.0.0/clone', payload: {} });
    expect(missing.statusCode).toBe(404);
  });
});

describe('builtin designer definitions', () => {
  it('both designers are schema-valid and self-identify as builtin authors', () => {
    const provider = { id: 'p1', name: 'P', type: 'openai', baseUrl: 'https://x.invalid/v1', defaultModel: 'm', hasKey: true } as never;
    for (const def of [buildAgentAuthor(provider), buildTeamAuthor(provider)]) {
      const load = validateDefinitionObject(def);
      expect(load.definition.metadata.tags).toContain('builtin');
      expect(load.definition.tools?.harness).toBe(false);
    }
    expect(AGENT_AUTHOR_ID).toBe('agent-author@builtin');
    expect(TEAM_AUTHOR_ID).toBe('team-author@builtin');
  });
});
