import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { SqliteAdapter } from '../store/sqlite.js';
import { clearMasterKeyCache } from '../core/crypto.js';
import { seedStarterAgents, seedSampleTeams, type SeededTeam } from './init.js';
import { dataDir as defaultDataDir } from '../core/install-paths.js';

export interface ResetOptions {
  dbPath: string;
  /** Where team workspaces and audit JSONL live. Defaults to the cwd. */
  workspaceRoot?: string;
  /** Remove the encryption key too, so the next init is a true new install. */
  newInstall?: boolean;
  /** Re-register the shipped starter agent and sample team. Defaults to true. */
  seedDefaults?: boolean;
  /** Copy the current DB next to it before wiping. */
  backup?: boolean;
  /** Directory holding `.master-key` (defaults to MINIONS_DATA_DIR or the platform data dir). */
  dataDir?: string;
}

export interface ResetResult {
  dbPath: string;
  backupPath?: string;
  tables: Record<string, number>;
  seededAgents: string[];
  seededTeams: SeededTeam[];
  removedPaths: string[];
  masterKeyRemoved: boolean;
}

/** Everything the platform can write. Missing tables are skipped, not fatal. */
const RESETTABLES = [
  // team orchestration
  'agent_run_events', 'agent_run_handoffs', 'agent_run_artifacts', 'agent_run_member_progress',
  'agent_run_messages', 'agent_run_sessions', 'agent_workflow_node_runs', 'agent_system_runs',
  'agent_workflow_versions', 'agent_system_versions', 'agent_systems', 'agent_definition_versions',
  // single-agent work
  'events', 'usage', 'transcripts', 'sessions', 'runs', 'agents',
  // chats + registry + platform state
  'chat_messages', 'chat_threads', 'mcp_servers', 'credentials',
  'settings', 'providers', 'projects', 'approvals', 'metrics_daily',
  // long-term memory
  'mem_nodes_fts', 'mem_edges_fts', 'mem_vectors', 'mem_feedback', 'mem_episodes',
  'mem_edges', 'mem_nodes', 'mem_datasets', 'mem_meta',
];

/**
 * Wipe runtime state and restore the shipped starter agents. Deliberately leaves
 * `evidence/`, `docs/`, `examples/` and the user's project workspace alone.
 */
export function resetDatabase(opts: ResetOptions): ResetResult {
  const dbPath = resolve(opts.dbPath);
  const workspaceRoot = resolve(opts.workspaceRoot ?? process.cwd());
  const dataDir = resolve(opts.dataDir ?? process.env.MINIONS_DATA_DIR ?? defaultDataDir());
  const db = new SqliteAdapter(dbPath);
  const tables: Record<string, number> = {};
  const removedPaths: string[] = [];
  let backupPath: string | undefined;

  try {
    // Fold the WAL into the main file before copying/deleting.
    try { db.raw.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* not in WAL mode */ }
    if (opts.backup && existsSync(dbPath)) {
      const dir = join(dataDir, 'backups');
      mkdirSync(dir, { recursive: true });
      backupPath = join(dir, `minion-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
      copyFileSync(dbPath, backupPath);
    }

    const available = new Set(
      (db.raw.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((r) => r.name),
    );
    const del = db.raw.transaction(() => {
      for (const table of RESETTABLES) {
        if (!available.has(table)) continue;
        const count = (db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
        if (count) tables[table] = count;
        db.raw.prepare(`DELETE FROM ${table}`).run();
      }
      if (available.has('sqlite_sequence')) {
        try { db.raw.prepare(`DELETE FROM sqlite_sequence`).run(); } catch { /* no autoincrement tables */ }
      }
    });
    del();

    for (const target of [join(workspaceRoot, 'teams'), join(dirname(dbPath), 'audit')]) {
      if (existsSync(target)) {
        rmSync(target, { recursive: true, force: true });
        removedPaths.push(target);
      }
    }

    let masterKeyRemoved = false;
    if (opts.newInstall) {
      const key = join(dataDir, '.master-key');
      if (existsSync(key)) { rmSync(key, { force: true }); masterKeyRemoved = true; }
      clearMasterKeyCache();
    }

    const seededAgents = opts.seedDefaults === false ? [] : seedStarterAgents(db);
    const seededTeams = opts.seedDefaults === false ? [] : seedSampleTeams(db);
    return { dbPath, backupPath, tables, seededAgents, seededTeams, removedPaths, masterKeyRemoved };
  } finally {
    db.close();
  }
}
