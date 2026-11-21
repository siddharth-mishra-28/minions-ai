import type Database from 'better-sqlite3';

type Db = Database.Database;

const hasColumn = (db: Db, table: string, col: string): boolean =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);

const addColumn = (db: Db, table: string, col: string, decl: string): void => {
  if (!hasColumn(db, table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
};

/**
 * Ordered, append-only migrations keyed by PRAGMA user_version. Each step is idempotent so
 * databases created before versioning existed (user_version 0 with tables already present)
 * upgrade cleanly. Never edit a shipped step — add a new one.
 */
const MIGRATIONS: ((db: Db) => void)[] = [
  // 1 — platform tables: settings, providers, projects, approvals, daily metric rollups
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS providers(
        id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'openai',
        base_url TEXT NOT NULL, default_model TEXT, credential_name TEXT,
        wire_api TEXT, azure_api_version TEXT, is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS projects(
        id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
        settings_json TEXT, created_at TEXT, last_opened_at TEXT);
      CREATE TABLE IF NOT EXISTS approvals(
        id TEXT PRIMARY KEY, thread_id TEXT, run_id TEXT, tool TEXT, args_json TEXT,
        status TEXT NOT NULL DEFAULT 'pending', scope TEXT, decided_by TEXT, reason TEXT,
        requested_at TEXT, decided_at TEXT);
      CREATE TABLE IF NOT EXISTS metrics_daily(
        day TEXT PRIMARY KEY, runs INTEGER DEFAULT 0, succeeded INTEGER DEFAULT 0, failed INTEGER DEFAULT 0,
        tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0, credits REAL DEFAULT 0,
        chat_messages INTEGER DEFAULT 0);
    `);
  },
  // 2 — link chats/runs to projects, add pin/archive/model override and audit path
  (db) => {
    addColumn(db, 'chat_threads', 'project_id', 'TEXT');
    addColumn(db, 'chat_threads', 'pinned', 'INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'chat_threads', 'archived', 'INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'chat_threads', 'model_override', 'TEXT');
    addColumn(db, 'chat_threads', 'approval_mode', 'TEXT');
    addColumn(db, 'chat_messages', 'meta_json', 'TEXT');
    addColumn(db, 'runs', 'source', "TEXT DEFAULT 'run'");
    addColumn(db, 'runs', 'thread_id', 'TEXT');
    addColumn(db, 'runs', 'project_id', 'TEXT');
    addColumn(db, 'runs', 'audit_path', 'TEXT');
  },
  // 3 — indexes for retention sweeps and history queries
  (db) => {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at);
      CREATE INDEX IF NOT EXISTS idx_runs_thread ON runs(thread_id);
      CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, seq);
      CREATE INDEX IF NOT EXISTS idx_msgs_thread ON chat_messages(thread_id, mtid);
      CREATE INDEX IF NOT EXISTS idx_threads_project ON chat_threads(project_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_approvals_thread ON approvals(thread_id, requested_at);
    `);
  },
  // 4 — agent teams: immutable definition history, team/workflow versions, and the
  //     run-scoped tables for nodes, sessions, messages, artifacts, handoffs and events.
  //     Purely additive: nothing above (agents, runs, events, chats) changes shape, so
  //     single-agent definitions and historical runs stay byte-identical.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_definition_versions(
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, version TEXT, definition_hash TEXT NOT NULL,
        definition_json TEXT NOT NULL, created_at TEXT);
      CREATE TABLE IF NOT EXISTS agent_systems(
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
        status TEXT NOT NULL DEFAULT 'draft', current_version TEXT,
        definition_json TEXT NOT NULL, definition_hash TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS agent_system_versions(
        system_id TEXT NOT NULL, version TEXT NOT NULL, definition_json TEXT NOT NULL,
        definition_hash TEXT NOT NULL, published_at TEXT, PRIMARY KEY(system_id, version));
      CREATE TABLE IF NOT EXISTS agent_workflow_versions(
        system_id TEXT NOT NULL, workflow_id TEXT NOT NULL, version TEXT NOT NULL,
        definition_json TEXT NOT NULL, definition_hash TEXT NOT NULL, created_at TEXT,
        PRIMARY KEY(system_id, workflow_id, version));
      CREATE TABLE IF NOT EXISTS agent_system_runs(
        id TEXT PRIMARY KEY, system_id TEXT NOT NULL, system_name TEXT, system_version TEXT NOT NULL,
        workflow_id TEXT NOT NULL, workflow_version TEXT NOT NULL, mode TEXT,
        status TEXT NOT NULL, snapshot_json TEXT NOT NULL, engine_version TEXT,
        task TEXT, workspace TEXT, limits_json TEXT,
        started_at TEXT, finished_at TEXT, error TEXT, created_at TEXT);
      CREATE TABLE IF NOT EXISTS agent_workflow_node_runs(
        id TEXT PRIMARY KEY, system_run_id TEXT NOT NULL, node_id TEXT NOT NULL, member_id TEXT,
        attempt INTEGER NOT NULL DEFAULT 1, iteration INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL, run_id TEXT, task TEXT, output_json TEXT, error TEXT,
        started_at TEXT, finished_at TEXT);
      CREATE TABLE IF NOT EXISTS agent_run_sessions(
        system_run_id TEXT NOT NULL, member_id TEXT NOT NULL, copilot_session_id TEXT NOT NULL,
        agent_id TEXT, workspace TEXT, created_at TEXT, last_used_at TEXT,
        PRIMARY KEY(system_run_id, member_id));
      CREATE TABLE IF NOT EXISTS agent_run_messages(
        id TEXT PRIMARY KEY, system_run_id TEXT NOT NULL, thread_id TEXT,
        from_member TEXT NOT NULL, to_members_json TEXT NOT NULL, type TEXT NOT NULL,
        body TEXT NOT NULL, artifact_ids_json TEXT, reply_to TEXT, task_id TEXT,
        node_id TEXT, created_at TEXT, delivered_at TEXT);
      CREATE TABLE IF NOT EXISTS agent_run_artifacts(
        id TEXT PRIMARY KEY, system_run_id TEXT NOT NULL, member_id TEXT NOT NULL,
        task_id TEXT, node_id TEXT, type TEXT NOT NULL, name TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1, content_hash TEXT NOT NULL, path TEXT,
        bytes INTEGER, created_at TEXT);
      CREATE TABLE IF NOT EXISTS agent_run_handoffs(
        id TEXT PRIMARY KEY, system_run_id TEXT NOT NULL, from_member TEXT NOT NULL,
        to_member TEXT NOT NULL, task_id TEXT, status TEXT NOT NULL,
        artifact_ids_json TEXT, summary TEXT, reason TEXT, created_at TEXT, decided_at TEXT);
      CREATE TABLE IF NOT EXISTS agent_run_events(
        id INTEGER PRIMARY KEY AUTOINCREMENT, system_run_id TEXT NOT NULL,
        seq INTEGER NOT NULL, ts TEXT, level TEXT, kind TEXT NOT NULL,
        member_id TEXT, node_id TEXT, payload_json TEXT);
    `);
  },
  // 5 — team-run indexes (timeline scans, artifact/message lookups, version history)
  (db) => {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_versions_hash ON agent_definition_versions(agent_id, definition_hash);
      CREATE INDEX IF NOT EXISTS idx_agent_versions_agent ON agent_definition_versions(agent_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_systems_updated ON agent_systems(updated_at);
      CREATE INDEX IF NOT EXISTS idx_system_runs_system ON agent_system_runs(system_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_system_runs_status ON agent_system_runs(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_node_runs_run ON agent_workflow_node_runs(system_run_id, node_id);
      CREATE INDEX IF NOT EXISTS idx_team_messages_run ON agent_run_messages(system_run_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_team_artifacts_run ON agent_run_artifacts(system_run_id, member_id);
      CREATE INDEX IF NOT EXISTS idx_team_handoffs_run ON agent_run_handoffs(system_run_id);
      CREATE INDEX IF NOT EXISTS idx_team_events_run ON agent_run_events(system_run_id, seq);
    `);
  },
  // 6 — A2A envelope + per-member progress. Purely additive: legacy messages keep
  //     working, the A2A columns stay null, and the progress board simply has no rows
  //     for runs created before this migration.
  (db) => {
    addColumn(db, 'agent_run_messages', 'message_id', 'TEXT');
    addColumn(db, 'agent_run_messages', 'context_id', 'TEXT');
    addColumn(db, 'agent_run_messages', 'protocol', 'TEXT');
    addColumn(db, 'agent_run_messages', 'parts_json', 'TEXT');
    addColumn(db, 'agent_run_messages', 'progress_json', 'TEXT');
    addColumn(db, 'agent_run_messages', 'updated_at', 'TEXT');
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_run_member_progress(
        system_run_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'waiting',
        percent INTEGER NOT NULL DEFAULT 0,
        phase TEXT,
        summary TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(system_run_id, member_id));
      CREATE INDEX IF NOT EXISTS idx_team_progress_run ON agent_run_member_progress(system_run_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_team_messages_a2a_id ON agent_run_messages(system_run_id, message_id);
    `);
  },
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function runMigrations(db: Db): number {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      MIGRATIONS[v](db);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  return MIGRATIONS.length;
}
