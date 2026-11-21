import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SqliteAdapter } from '../src/store/sqlite.js';
import { TeamStore } from '../src/store/teams.js';
import { agentDefinition, hashOf, sequentialTeam } from './team-fixtures.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const useDist = existsSync(join(root, 'dist', 'cli.js'));
// Invoke the TypeScript entrypoint through the local tsx loader (no shell: the project
// path contains spaces, and `npx` through a shell splits it into a directory import).
const TSX = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI_CMD = process.execPath;
const CLI_ARGS = useDist ? [join(root, 'dist', 'cli.js')] : [TSX, join(root, 'src', 'cli.ts')];

const base = mkdtempSync(join(tmpdir(), 'team-cli-'));
const dbPath = join(base, 'teams.db');

function cli(...args: string[]): { status: number | null; out: string; err: string } {
  const r = spawnSync(CLI_CMD, [...CLI_ARGS, ...args], {
    encoding: 'utf8', cwd: root, timeout: 120_000,
  });
  return { status: r.status, out: String(r.stdout ?? ''), err: String(r.stderr ?? '') };
}

/** Register the fixture agents the definition pins, exactly as `agent register` would. */
function seedAgents(names: string[]): Record<string, { agentId: string; version: string; definitionHash: string }> {
  const db = new SqliteAdapter(dbPath);
  try {
    const refs: Record<string, { agentId: string; version: string; definitionHash: string }> = {};
    for (const name of names) {
      const def = agentDefinition(name);
      const hash = hashOf(def);
      db.saveAgent(name, '1.0.0', JSON.stringify(def), hash);
      refs[name] = { agentId: `${name}@1.0.0`, version: '1.0.0', definitionHash: hash };
    }
    return refs;
  } finally { db.close(); }
}

const write = (name: string, value: unknown): string => {
  const p = join(base, name);
  writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  return p;
};

const teamJson = (refs: Record<string, { agentId: string; version: string; definitionHash: string }>) =>
  sequentialTeam(['analyst', 'developer', 'qa'].map((memberId) => ({ memberId, role: `${memberId} role`, ...refs[memberId] })));

afterAll(() => {
  try { rmSync(base, { recursive: true, force: true }); } catch { /* windows fs lag */ }
});

describe('minions-assembler team — validate', () => {
  it('0 for a valid definition that resolves its agent pins', () => {
    const def = teamJson(seedAgents(['analyst', 'developer', 'qa']));
    const r = cli('team', 'validate', '--definition', write('ok.team.json', def), '--db', dbPath);
    expect(r.status, r.err).toBe(0);
    expect(r.out).toContain('valid: delivery-team');
    expect(r.out).toMatch(/hash sha256:/);
  });

  it('2 for a schema violation and for an unregistered agent pin', () => {
    const schema = cli('team', 'validate', '--definition', write('bad.team.json', { schemaVersion: '1.0' }), '--db', dbPath);
    expect(schema.status).toBe(2);
    expect(schema.err).toContain('invalid:');

    const refs = seedAgents(['analyst', 'developer', 'qa']);
    const unknown = teamJson(refs);
    (unknown.team as { members: { agentRef: { agentId: string } }[] }).members[0].agentRef.agentId = 'ghost@1.0.0';
    const missing = cli('team', 'validate', '--definition', write('ghost.team.json', unknown), '--db', dbPath);
    expect(missing.status).toBe(2);
    expect(missing.err).toMatch(/ghost/i);
  });
});

describe('minions-assembler team — publish / list / show', () => {
  it('publishes an immutable version, then lists and shows the team', () => {
    const published = cli('team', 'publish', '--definition', join(base, 'ok.team.json'), '--db', dbPath);
    expect(published.status, published.err).toBe(0);
    expect(published.out).toContain('published: delivery-team@1.0.0');
    expect(published.out).toContain('1 workflow(s)');

    const again = cli('team', 'publish', '--definition', join(base, 'ok.team.json'), '--publish-version', '1.1.0', '--db', dbPath);
    expect(again.status, again.err).toBe(0);
    expect(again.out).toContain('delivery-team@1.1.0');

    const list = cli('team', 'list', '--db', dbPath);
    expect(list.status).toBe(0);
    const teams = JSON.parse(list.out) as { id: string; currentVersion: string; members: { memberId: string }[]; workflows: { workflowId: string }[] }[];
    const row = teams.find((t) => t.id === 'delivery-team')!;
    expect(row.currentVersion).toBe('1.1.0');
    expect(row.members.map((m) => m.memberId)).toEqual(['analyst', 'developer', 'qa']);
    expect(row.workflows[0].workflowId).toBe('delivery');

    const show = cli('team', 'show', 'delivery-team', '--db', dbPath);
    expect(show.status).toBe(0);
    const detail = JSON.parse(show.out) as { definition: { metadata: { id: string } }; validation: { ok: boolean }; versions: { version: string }[] };
    expect(detail.definition.metadata.id).toBe('delivery-team');
    expect(detail.validation.ok).toBe(true);
    expect(detail.versions.map((v) => v.version).sort()).toEqual(['1.0.0', '1.1.0']);

    expect(cli('team', 'show', 'ghost', '--db', dbPath).status).toBe(2);
  });
});

describe('minions-assembler team — run inspection', () => {
  it('2 for unknown runs, and exports an existing run bundle to disk', () => {
    expect(cli('team', 'status', 'team_missing', '--db', dbPath).status).toBe(2);
    expect(cli('team', 'export', 'team_missing', '--db', dbPath).status).toBe(2);
    expect(cli('team', 'stop', 'team_missing', '--db', dbPath).status).toBe(2);
    expect(cli('team', 'resume', 'team_missing', '--db', dbPath).status).toBe(2);

    // Persist a run directly: the CLI reads whatever the store holds, no model involved.
    const db = new SqliteAdapter(dbPath);
    try {
      const store = new TeamStore(db);
      store.createSystemRun({
        id: 'team_cli_fixture', systemId: 'delivery-team', systemName: 'Delivery Team', systemVersion: '1.1.0',
        workflowId: 'delivery', workflowVersion: '1.0.0', mode: 'sequential', status: 'done',
        snapshotJson: JSON.stringify({ schemaVersion: '1.0', kind: 'agent-run-snapshot', runId: 'team_cli_fixture' }),
        engineVersion: '1.0.0', task: 'CLI export fixture', workspace: base, limitsJson: '{}',
      });
      store.appendEvent({ systemRunId: 'team_cli_fixture', kind: 'run.queued', payload: { source: 'cli-test' } });
    } finally { db.close(); }

    const status = cli('team', 'status', 'team_cli_fixture', '--db', dbPath);
    expect(status.status).toBe(0);
    const parsed = JSON.parse(status.out) as { run: { id: string; status: string }; events: { kind: string }[] };
    expect(parsed.run.id).toBe('team_cli_fixture');
    expect(parsed.run.status).toBe('done');
    expect(parsed.events.some((e) => e.kind === 'run.queued')).toBe(true);

    const out = join(base, 'bundle.json');
    const exported = cli('team', 'export', 'team_cli_fixture', '--out', out, '--db', dbPath);
    expect(exported.status, exported.err).toBe(0);
    expect(exported.out).toContain(out);
    const bundle = JSON.parse(readFileSync(out, 'utf8')) as { run: { id: string }; events: { kind: string }[]; nodes: unknown[] };
    expect(bundle.run.id).toBe('team_cli_fixture');
    expect(bundle.events.length).toBeGreaterThan(0);
    expect(bundle.nodes).toEqual([]);
  });
});
