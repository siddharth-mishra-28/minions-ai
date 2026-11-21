#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { loadAgentDefinition, validateDefinitionObject, redactedForLog, hydrateAgentDefinition } from './agents/loader.js';
import { loadAgentMarkdown } from './agents/md-profile.js';
import { sealDefinitionSecrets } from './agents/provider-keys.js';
import { executeRun } from './execution/runner.js';
import { executeChatTurn } from './execution/chat-runner.js';
import { validateMcpConfig, probeMcpTools } from './mcp/mcp.js';
import type { McpServerConfig } from './mcp/mcp.js';
import { SqliteAdapter } from './store/sqlite.js';
import { TeamStore } from './store/teams.js';
import { TeamEngine } from './execution/team/engine.js';
import { createCopilotExecutor } from './execution/team/executor.js';
import { TeamService } from './systems/service.js';
import { teamCard } from './a2a/cards.js';
import { buildTask } from './a2a/mapper.js';
import { startServer } from './serve.js';
import { resolveWorkspace } from './core/workspace.js';
import { openMemoryStore } from './memory/sqlite-store.js';
import { createMemoryRuntime } from './memory/runtime.js';
import { loadPlatformDefaults, resolveMemoryConfig, savePlatformDefaults } from './memory/config.js';
import { indexCodeGraph } from './memory/code-index.js';
import { improve } from './memory/lessons.js';
import { recall } from './memory/retrieve.js';
import { PLATFORM_DATASET } from './memory/config.js';
import { slug } from './memory/text.js';
import { runInit, postinstallInit } from './onboarding/init.js';
import { runSetupWizard } from './onboarding/wizard.js';
import { resetDatabase } from './onboarding/reset.js';
import { defaultDbPath } from './core/install-paths.js';
import { moduleFile } from './core/module-path.js';

const program = new Command();
program.name('minions-ai').description('Minions-ai — a fully configurable software factory of custom AI agent teams').version('1.0.0');

program.command('validate')
  .requiredOption('--agentDefinition <path>', 'Path to agent definition JSON')
  .action((opts) => {
    try {
      const { definition, warnings, definitionHash } = loadAgentDefinition(opts.agentDefinition);
      console.log(`valid: ${definition.metadata.name}@${definition.metadata.version} (hash ${definitionHash})`);
      for (const w of warnings) console.warn(`warning: ${w}`);
    } catch (e) {
      console.error(`invalid: ${(e as Error).message}`);
      process.exit(2);
    }
  });

program.command('run')
  .requiredOption('--agentDefinition <path>', 'Path to agent definition JSON')
  .option('--task <text>', 'Override task prompt')
  .option('--sessionId <id>', 'Resume/pin session id')
  .option('--resume', 'Resume existing session id')
  .option('--no-stream', 'Disable streaming delta output')
  .option('--output-format <fmt>', 'text|json', 'text')
  .option('--share <path>', 'Write Markdown transcript after completion')
  .option('--db <path>', 'SQLite path', defaultDbPath())
  .option('--runDir <path>', 'Explicit working directory for this run (default: <workspace>/run_<id>); useful for phase builds')
  .option('--yes', 'Explicit CI approval for approve-all-ci-only policies (alias of --approval autopilot)')
  .option('--approval <mode>', 'Headless approval mode: autopilot (auto-approve every ask) | strict (deny every ask)')
  .option('--audit-level <level>', 'Audit verbosity: minimal|default|full (falls back to AUDIT_LEVEL env, then default)')
  .action(async (opts) => {
    const started = Date.now();
    try {
      const { definition: portable, resolved: definition, warnings } = loadAgentDefinition(opts.agentDefinition);
      for (const w of warnings) console.warn(`warning: ${w}`);
      if (opts.approval && !['autopilot', 'strict'].includes(opts.approval)) throw new Error("--approval must be autopilot or strict (got '${opts.approval}')");
      const approval = (opts.approval as 'autopilot' | 'strict' | undefined) ?? (opts.yes ? 'autopilot' : undefined);
      // Same storage contract as POST /api/agents: seal literal secrets, keep ${ENV}
      // refs portable, and snapshot the sealed form onto the run.
      const sealed = sealDefinitionSecrets(portable);
      const sealedHash = createHash('sha256').update(JSON.stringify(sealed)).digest('hex').slice(0, 16);
      const portableJson = JSON.stringify(sealed);
      const db = new SqliteAdapter(opts.db);
      const memoryStore = openMemoryStore(opts.db);
      const agentId = db.saveAgent(sealed.metadata.name, sealed.metadata.version, portableJson, sealedHash);
      const memoryConfig = resolveMemoryConfig(memoryStore, definition);
      const memory = memoryConfig.enabled
        ? createMemoryRuntime({
            store: memoryStore, config: memoryConfig, definition, agentId,
            task: opts.task ?? definition.task.prompt, sessionId: opts.sessionId,
          })
        : undefined;
      // Wire the MCP registry so mcp.use refs resolve in CLI runs too
      let mcpRegistry: Map<string, import('./mcp/mcp.js').McpServerConfig> | undefined;
      let mcpRegistryTools: Map<string, string[]> | undefined;
      if (definition.mcp?.use?.length) {
        const registry = new Map<string, import('./mcp/mcp.js').McpServerConfig>();
        const tools = new Map<string, string[]>();
        for (const row of db.listMcpServers()) {
          try {
            registry.set(row.name, JSON.parse((db.getMcpServer(row.name) as { config_json: string }).config_json));
            const tj = row.tools_json ? JSON.parse(row.tools_json) as { name: string }[] : [];
            tools.set(row.name, tj.map((t) => t.name));
          } catch { /* skip malformed rows */ }
        }
        mcpRegistry = registry; mcpRegistryTools = tools;
      }
      mkdirSync('./runs', { recursive: true });
      let streamed = '';
      const result = await executeRun({
        definition, agentId, definitionHash: sealedHash, definitionSnapshot: portableJson, db,
        runDir: opts.runDir ? resolve(opts.runDir) : undefined,
        taskOverride: opts.task,
        ciApproveAll: Boolean(opts.yes),
        approvalMode: approval,
        auditLevel: (opts.auditLevel as 'minimal' | 'default' | 'full' | undefined) || undefined,
        resumeSessionId: opts.sessionId,
        streamOut: opts.stream === false ? undefined : (t) => { streamed += t; process.stdout.write(t); },
        mcpRegistry, mcpRegistryTools,
        memory,
      });
      if (opts.stream !== false && streamed && !result.text.startsWith(streamed.slice(0, 50))) process.stdout.write('\n');
      if (opts.share) {
        writeFileSync(opts.share, `# ${definition.metadata.name} — ${result.runId}\n\ntrace: ${result.traceId}\nsession: ${result.sessionId}\n\n---\n\n${result.text}\n`);
        try {
          const sha = createHash('sha256').update(result.text).digest('hex');
          (db as SqliteAdapter).saveTranscript(result.runId, opts.share, sha);
        } catch { /* noop */ }
      }
      const durationMs = Date.now() - started;
      if (opts.outputFormat === 'json') {
        console.log(JSON.stringify({ runId: result.runId, sessionId: result.sessionId, traceId: result.traceId, agentId, status: 'done', durationMs, text: result.text }));
      } else {
        if (opts.stream === false) console.log(result.text);
        console.error(`\ndone: ${result.runId} trace=${result.traceId} session=${result.sessionId} (${durationMs}ms)`);
      }
      db.close();
      memoryStore.close();
    } catch (e) {
      const msg = (e as Error).message;
      if (/Schema|Duplicate|defaultAgent|acknowledgeReplaceRisks|Invalid JSON/i.test(msg)) { console.error(`validation error: ${msg}`); process.exit(2); }
      if (/permission|approve-all/i.test(msg)) { console.error(`permission error: ${msg}`); process.exit(4); }
      console.error(`runtime error: ${msg}`);
      process.exit(3);
    }
  });

program.command('import-md')
  .description('Import a markdown agent profile (.agent.md frontmatter + prompt body) and register it as a regular agent')
  .requiredOption('--file <path>', 'Path to the .agent.md / .md profile')
  .option('--no-register', 'Only print the mapped definition JSON without saving')
  .option('--db <path>', 'SQLite path', defaultDbPath())
  .action(async (opts: { file: string; register: boolean; db: string }) => {
    try {
      const { definition, profile } = loadAgentMarkdown(opts.file);
      const validated = validateDefinitionObject(definition);
      const defJson = JSON.stringify(validated.definition, null, 2);
      if (!opts.register) { console.log(defJson); return; }
      const sealed = sealDefinitionSecrets(validated.definition);
      const hash = createHash('sha256').update(JSON.stringify(sealed)).digest('hex').slice(0, 16);
      const db = new SqliteAdapter(opts.db);
      try {
        const id = db.saveAgent(sealed.metadata.name, sealed.metadata.version, JSON.stringify(sealed), hash);
        console.log(`imported: ${id} (hash ${hash}) from markdown profile "${profile.name}" — runs on the default Copilot system prompt`);
        for (const w of validated.warnings) console.warn(`warning: ${w}`);
      } finally { db.close(); }
    } catch (e) {
      console.error(`import failed: ${(e as Error).message}`);
      process.exit(2);
    }
  });

program.command('mcp')
  .description('MCP registry operations')
  .command('register')
  .requiredOption('--name <name>', 'Registry key (referenced by definitions via mcp.use)')
  .requiredOption('--config <jsonOrPath>', 'Config JSON string or path to a JSON file')
  .option('--description <text>')
  .option('--probe', 'Connect now and store the discovered tool list')
  .option('--db <path>', 'SQLite path', defaultDbPath())
  .action(async (opts: { name: string; config: string; description?: string; probe?: boolean; db: string }) => {
    let raw: string;
    try { raw = readFileSync(opts.config, 'utf8').trim(); } catch { raw = opts.config; }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch (e) { console.error(`config is not valid JSON: ${(e as Error).message}`); process.exit(2); }
    const db = new SqliteAdapter(opts.db);
    try {
      const { config } = await validateMcpConfig(parsed);
      let toolsJson: string | undefined;
      if (opts.probe) {
        const tools = await probeMcpTools(config);
        toolsJson = JSON.stringify(tools);
        db.updateMcpServerTools(opts.name, toolsJson);
        console.log(`probed ${tools.length} tool(s): ${tools.map((t: { name: string }) => t.name).join(', ')}`);
      }
      db.saveMcpServer({ name: opts.name, config_json: JSON.stringify(config), description: opts.description, tools_json: toolsJson });
      console.log(`registered: ${opts.name} — reference it from a definition with "mcp": { "use": ["${opts.name}"] }`);
    } catch (e) {
      console.error(`register failed: ${(e as Error).message}`); process.exit(3);
    } finally { db.close(); }
  });

program.command('mcp-list')
  .description('List registered MCP servers')
  .option('--db <path>', 'SQLite path', defaultDbPath())
  .action(async (opts: { db: string }) => {
    const db = new SqliteAdapter(opts.db);
    console.log(JSON.stringify(db.listMcpServers(), null, 2));
    db.close();
  });

async function openBrowser(url: string): Promise<void> {
  try {
    const [cmd, args] = process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.unref();
  } catch { /* headless machines: the URL is printed anyway */ }
}

program.command('serve')
  .description('Start the cockpit, REST API, Swagger and A2A without opening a browser')
  .option('--port <n>', 'Port', '3100')
  .option('--db <path>', 'SQLite path', defaultDbPath())
  .option('--open', 'Open the cockpit in the default browser')
  .action(async (opts) => {
    await startServer(Number(opts.port), opts.db);
    const url = `http://127.0.0.1:${opts.port}`;
    console.log(`minions-ai serve on ${url} (docs: ${url}/docs)`);
    if (opts.open) await openBrowser(url);
  });

program.command('ui')
  .description('Start the cockpit and open it in the default browser')
  .option('--port <n>', 'Port', '3100')
  .option('--db <path>', 'SQLite path', defaultDbPath())
  .option('--no-open', 'Do not open a browser (headless machines)')
  .action(async (opts) => {
    await startServer(Number(opts.port), opts.db);
    const url = `http://127.0.0.1:${opts.port}`;
    console.log(`minions-ai cockpit on ${url} (docs: ${url}/docs)`);
    if (opts.open) await openBrowser(url);
  });

program.command('list').option('--db <path>', 'SQLite path', defaultDbPath()).action((opts) => {
  const db = new SqliteAdapter(opts.db);
  console.log(JSON.stringify(db.listAgents(), null, 2));
  db.close();
});

program.command('show').argument('<id>').option('--db <path>', 'SQLite path', defaultDbPath()).action((id, opts) => {
  const db = new SqliteAdapter(opts.db);
  const agent = db.getAgent(id);
  console.log(agent ? JSON.stringify({ ...agent, definition: redactedForLog(JSON.parse((agent as { definition_json: string }).definition_json)) }, null, 2) : 'not found');
  db.close();
});

program.command('history').option('--agentId <id>').option('--db <path>', 'SQLite path', defaultDbPath()).action((opts) => {
  const db = new SqliteAdapter(opts.db);
  console.log(JSON.stringify(db.listRuns(opts.agentId), null, 2));
  db.close();
});

// ---------- chat: persistent threads with registered agents (multi-turn) ----------
const chat = program.command('chat').description('Chat threads with registered agents (persistent multi-turn sessions)');
chat.command('create')
  .requiredOption('--agent <id>', 'Registered agent id (name@version)')
  .option('--title <text>', 'Optional thread title')
  .option('--db <path>', 'SQLite path', defaultDbPath())
  .action((opts) => {
    const db = new SqliteAdapter(opts.db);
    if (!db.getAgent(opts.agent)) { console.error(`agent not found: ${opts.agent}`); process.exitCode = 2; db.close(); return; }
    const id = db.createChatThread({ title: opts.title || `Chat with ${opts.agent}`, agentId: opts.agent, sessionId: null });
    console.log(JSON.stringify({ threadId: id, agentId: opts.agent, title: opts.title || `Chat with ${opts.agent}` }));
    db.close();
  });
chat.command('list').option('--db <path>', 'SQLite path', defaultDbPath()).action((opts) => {
  const db = new SqliteAdapter(opts.db);
  console.log(JSON.stringify(db.listChatThreads(), null, 2));
  db.close();
});
chat.command('send')
  .requiredOption('--thread <id>', 'Thread id from `chat create`')
  .requiredOption('--message <text>', 'User message for this turn')
  .option('--db <path>', 'SQLite path', defaultDbPath())
  .option('--timeout-ms <n>', 'Per-turn budget in ms', '2700000')
  .action(async (opts) => {
    const db = new SqliteAdapter(opts.db);
    const t = db.getChatThread(opts.thread);
    if (!t) { console.error(`chat thread not found: ${opts.thread}`); process.exitCode = 2; db.close(); return; }
    const agentId = t.agent_id as string | null;
    if (!agentId) { console.error('thread has no fixed agent — use chat send with an @mention to route a general thread'); process.exitCode = 2; db.close(); return; }
    const row = db.getAgent(agentId);
    if (!row) { console.error(`agent not found: ${agentId}`); process.exitCode = 2; db.close(); return; }
    const hydrated = hydrateAgentDefinition(row.definition_json as string);
    const def = hydrated.resolved;
    const threadDir = resolve(`./.chats/${opts.thread}`);
    mkdirSync(threadDir, { recursive: true });
    const userMessageId = db.addChatMessage(opts.thread, { role: 'user', author: 'user', content: opts.message });
    const memoryStore = openMemoryStore(opts.db);
    const memoryConfig = resolveMemoryConfig(memoryStore, def);
    const memory = memoryConfig.enabled
      ? createMemoryRuntime({
          store: memoryStore, config: memoryConfig, definition: def, agentId,
          task: opts.message, threadId: opts.thread,
        })
      : undefined;
    try {
      const turn = await executeChatTurn({
        definition: def, agentId, db,
        definitionHash: (row.definition_hash as string | null) || hydrated.definitionHash,
        definitionSnapshot: row.definition_json as string,
        sessionId: (t.session_id as string | null) ?? undefined,
        sessionIdPrefix: 'chat',
        content: opts.message,
        workingDirectory: threadDir,
        turnTimeoutMs: Number(opts.timeoutMs),
        memory,
      });
      db.updateChatThread(opts.thread, { sessionId: turn.sessionId });
      const replyMessageId = db.addChatMessage(opts.thread, { role: 'assistant', author: agentId, content: turn.text, runId: turn.runId });
      console.log(JSON.stringify({ userMessageId, replyMessageId, runId: turn.runId, agentId, text: turn.text }, null, 2));
    } catch (e) {
      console.error(`chat turn failed: ${(e as Error).message}`);
      process.exitCode = 3;
    } finally { db.close(); memoryStore.close(); }
  });
chat.command('read').requiredOption('--thread <id>').option('--db <path>', 'SQLite path', defaultDbPath()).action((opts) => {
  const db = new SqliteAdapter(opts.db);
  const t = db.getChatThread(opts.thread);
  if (!t) { console.error(`chat thread not found: ${opts.thread}`); process.exitCode = 2; db.close(); return; }
  console.log(JSON.stringify({ ...t, messages: db.getChatMessages(opts.thread) }, null, 2));
  db.close();
});

// ---------------- memory ----------------
const memory = program.command('memory').description('Long-term memory: code graph, learned lessons, platform config (same SQLite db)');

memory.command('index')
  .description('Build/refresh the code graph (incremental; symbols + imports + tests)')
  .option('--root <path>', 'Root to index (default: platform codeGraph.root, or the workspace)')
  .option('--dataset <id>', 'Dataset to write into', PLATFORM_DATASET)
  .option('--no-symbols', 'Index files/imports only (skip symbol extraction)')
  .option('--db <path>', 'SQLite path', defaultDbPath())
  .action((opts: { root?: string; dataset: string; symbols: boolean; db: string }) => {
    const store = openMemoryStore(opts.db);
    try {
      const cfg = loadPlatformDefaults(store);
      const started = Date.now();
      const result = indexCodeGraph(store, {
        root: resolve(opts.root ?? cfg.codeGraph.root ?? '.'),
        dataset: opts.dataset,
        include: cfg.codeGraph.include,
        exclude: cfg.codeGraph.exclude,
        maxFiles: cfg.codeGraph.maxFiles,
        symbols: opts.symbols !== false,
        removeStale: true,
      });
      console.log(`indexed ${result.files} files, ${result.symbols} symbols, ${result.edges} edges`
        + `${result.removed ? `, removed ${result.removed} stale` : ''} in ${Date.now() - started}ms`
        + `${result.truncated ? ' (truncated: caps reached)' : ''}`);
    } finally { store.close(); }
  });

memory.command('search <query>')
  .description('Recall from memory (lexical seeds + graph expansion)')
  .option('--dataset <ids>', 'Comma-separated datasets (default: all)')
  .option('--k <n>', 'Max seed nodes', '8')
  .option('--hops <n>', 'Graph expansion depth', '1')
  .option('--json', 'Print JSON instead of the rendered block')
  .option('--db <path>', 'SQLite path', defaultDbPath())
  .action(async (query: string, opts: { dataset?: string; k: string; hops: string; json?: boolean; db: string }) => {
    const store = openMemoryStore(opts.db);
    try {
      const cfg = loadPlatformDefaults(store);
      const datasets = opts.dataset ? opts.dataset.split(',').map((d) => d.trim()).filter(Boolean) : store.listDatasets().map((d) => d.id);
      const result = await recall(store, cfg, { query, datasets, k: Number(opts.k), hops: Number(opts.hops), mode: cfg.retrieval.mode });
      if (opts.json) {
        console.log(JSON.stringify({ mode: result.mode, nodes: result.nodes.map((n) => ({ type: n.node.node_type, name: n.node.name, score: Number(n.score.toFixed(3)), via: n.via })) }, null, 2));
      } else {
        console.log(result.rendered || '(nothing recalled)');
      }
    } finally { store.close(); }
  });

memory.command('recall')
  .description('Show exactly what memory would be injected for an agent + task')
  .requiredOption('--agent <id>', 'Registered agent id (name@version)')
  .option('--task <text>', 'Task text to recall for')
  .option('--db <path>', 'SQLite path', defaultDbPath())
  .action(async (opts: { agent: string; task?: string; db: string }) => {
    const db = new SqliteAdapter(opts.db);
    const store = openMemoryStore(opts.db);
    try {
      const row = db.getAgent(opts.agent);
      if (!row) { console.error(`agent not found: ${opts.agent}`); process.exitCode = 2; return; }
      const { resolved } = hydrateAgentDefinition(row.definition_json as string);
      const cfg = resolveMemoryConfig(store, resolved);
      if (!cfg.enabled) { console.log('(memory disabled for this agent)'); return; }
      const rt = createMemoryRuntime({ store, config: cfg, definition: resolved, agentId: opts.agent, task: opts.task });
      const out = await rt.recall(opts.task ?? resolved.task.prompt);
      console.log(out.block ?? '(nothing recalled)');
      console.error(`\nmode=${out.mode} nodes=${out.nodes} chars=${out.chars} datasets=${out.datasets.join(',')}`);
    } finally { db.close(); store.close(); }
  });

memory.command('stats')
  .description('Node/edge/episode counts')
  .option('--dataset <id>', 'Restrict to one dataset')
  .option('--db <path>', 'SQLite path', defaultDbPath())
  .action((opts: { dataset?: string; db: string }) => {
    const store = openMemoryStore(opts.db);
    try { console.log(JSON.stringify(store.stats(opts.dataset), null, 2)); } finally { store.close(); }
  });

memory.command('lesson')
  .description('Record a lesson manually')
  .requiredOption('--text <text>', 'The actionable lesson')
  .requiredOption('--trigger <text>', 'The error/command/situation that triggers it')
  .option('--dataset <id>', 'Dataset', PLATFORM_DATASET)
  .option('--db <path>', 'SQLite path', defaultDbPath())
  .action((opts: { text: string; trigger: string; dataset: string; db: string }) => {
    const store = openMemoryStore(opts.db);
    try {
      const node = store.upsertNode({
        dataset: opts.dataset,
        node_type: 'Lesson',
        name: `lesson:manual:${slug(opts.trigger)}`,
        content: opts.text.slice(0, 600),
        node_set: 'pitfalls',
        properties_json: JSON.stringify({ manual: true, trigger: opts.trigger.slice(0, 300) }),
        importance: 0.7,
      });
      console.log(`lesson saved: ${node.id} (${node.dataset})`);
    } finally { store.close(); }
  });

memory.command('improve')
  .description('Decay stale weights, rebuild co-change edges, promote cross-agent lessons')
  .option('--dataset <id>', 'Limit co-change/promotion to one dataset')
  .option('--db <path>', 'SQLite path', defaultDbPath())
  .action((opts: { dataset?: string; db: string }) => {
    const store = openMemoryStore(opts.db);
    try { console.log(JSON.stringify(improve(store, loadPlatformDefaults(store), { dataset: opts.dataset }), null, 2)); } finally { store.close(); }
  });

memory.command('promote')
  .description('Copy a node into the shared platform dataset')
  .requiredOption('--id <nodeId>', 'Memory node id')
  .option('--db <path>', 'SQLite path', defaultDbPath())
  .action((opts: { id: string; db: string }) => {
    const store = openMemoryStore(opts.db);
    try {
      const node = store.getNode(opts.id);
      if (!node) { console.error(`memory node not found: ${opts.id}`); process.exitCode = 2; return; }
      if (node.dataset === PLATFORM_DATASET) { console.error('node already belongs to the platform dataset'); process.exitCode = 2; return; }
      const promoted = store.upsertNode({
        dataset: PLATFORM_DATASET, node_type: node.node_type, name: node.name, content: node.content,
        node_set: node.node_set, importance: Math.max(Number(node.importance), 0.6),
        properties_json: JSON.stringify({ promoted_from: [node.dataset] }),
      });
      console.log(`promoted ${node.id} → ${promoted.id} (${promoted.dataset})`);
    } finally { store.close(); }
  });

memory.command('forget')
  .description('Delete one node, or an entire dataset (row deletes only)')
  .option('--id <nodeId>', 'Memory node id')
  .option('--dataset <id>', 'Dataset to clear')
  .option('--db <path>', 'SQLite path', defaultDbPath())
  .action((opts: { id?: string; dataset?: string; db: string }) => {
    if (!opts.id && !opts.dataset) { console.error('pass --id or --dataset'); process.exitCode = 2; return; }
    const store = openMemoryStore(opts.db);
    try {
      const removed = opts.id ? (store.deleteNode(opts.id) ? 1 : 0) : store.deleteDataset(opts.dataset!);
      console.log(`forgot ${removed} row(s)`);
    } finally { store.close(); }
  });

memory.command('config')
  .description('Show or update platform memory defaults')
  .option('--set <json>', 'Partial JSON merged over the current defaults')
  .option('--db <path>', 'SQLite path', defaultDbPath())
  .action((opts: { set?: string; db: string }) => {
    const store = openMemoryStore(opts.db);
    try {
      if (opts.set) {
        let patch: unknown;
        try { patch = JSON.parse(opts.set); } catch { console.error('--set must be valid JSON'); process.exitCode = 2; return; }
        console.log(JSON.stringify(savePlatformDefaults(store, patch), null, 2));
      } else {
        console.log(JSON.stringify(loadPlatformDefaults(store), null, 2));
      }
    } finally { store.close(); }
  });

// ---------------- agent teams ----------------
const team = program.command('team').description('Agent teams: validate, publish immutable versions, run and inspect orchestrated runs');

/** Build the team stack (store + Copilot executor + engine + service) against one db. */
const openTeamStack = async (dbPath: string) => {
  const db = new SqliteAdapter(dbPath);
  const memoryStore = openMemoryStore(dbPath);
  const store = new TeamStore(db);
  const auditRoot = resolve(dirname(resolve(dbPath)), 'audit');
  const executor = createCopilotExecutor({ db, auditRoot });
  const engine = new TeamEngine({
    store, executor, lookup: db, workspaceRoot: resolveWorkspace().root,
    memoryFor: (input) => {
      const config = resolveMemoryConfig(memoryStore, input.definition);
      if (!config.enabled) return undefined;
      return createMemoryRuntime({ store: memoryStore, config, definition: input.definition, agentId: `${input.agentId}#${input.memberId}`, task: input.task });
    },
  });
  const service = new TeamService({ db, store, engine, workspaceRoot: resolveWorkspace().root });
  return { db, store, engine, service, memoryStore, close: () => { try { db.close(); } catch { /* closed */ } try { memoryStore.close(); } catch { /* closed */ } } };
};

team.command('validate')
  .description('Validate a team definition (schema + agent pins + workflow graph)')
  .requiredOption('--definition <path>', 'Path to agent-system-definition JSON')
  .option('--db <path>', 'SQLite path (agent registry for pin resolution)', defaultDbPath())
  .action(async (opts: { definition: string; db: string }) => {
    const stack = await openTeamStack(opts.db);
    try {
      const json = JSON.parse(readFileSync(opts.definition, 'utf8')) as { metadata?: { id?: string; name?: string; version?: string } };
      const report = stack.service.validate(json);
      if (!report.ok) {
        console.error(`invalid: ${report.errors.join('; ')}`);
        process.exitCode = 2;
        return;
      }
      console.log(`valid: ${json.metadata?.id ?? 'team'} (hash ${report.definitionHash})`);
      for (const w of report.warnings) console.warn(`warning: ${w}`);
    } catch (e) {
      console.error(`invalid: ${(e as Error).message}`);
      process.exitCode = 2;
    } finally { stack.close(); }
  });

team.command('publish')
  .description('Register/update a team from a definition file and publish an immutable runnable version')
  .requiredOption('--definition <path>', 'Path to agent-system-definition JSON')
  // `--version` is reserved by commander's global version flag, so name it explicitly.
  .option('--publish-version <v>', 'Override the version recorded for this publish')
  .option('--db <path>', 'SQLite path', defaultDbPath())
  .action(async (opts: { definition: string; publishVersion?: string; db: string }) => {
    const stack = await openTeamStack(opts.db);
    try {
      const json = JSON.parse(readFileSync(opts.definition, 'utf8')) as { metadata: { id: string } };
      const existing = stack.store.getSystem(json.metadata.id);
      const saved = existing ? stack.service.update(json.metadata.id, json) : stack.service.create(json);
      const published = stack.service.publish(saved.id as string, opts.publishVersion);
      console.log(`published: ${published.id}@${published.currentVersion} (hash ${published.definitionHash}) — ${(published.definition as { orchestration: { workflows: { workflowId: string }[] } }).orchestration.workflows.length} workflow(s)`);
      for (const w of (published.validation as { warnings: string[] }).warnings) console.warn(`warning: ${w}`);
    } catch (e) {
      console.error(`publish failed: ${(e as Error).message}`);
      process.exitCode = 2;
    } finally { stack.close(); }
  });

team.command('list')
  .description('List teams with member and workflow summaries')
  .option('--db <path>', 'SQLite path', defaultDbPath())
  .action(async (opts: { db: string }) => {
    const stack = await openTeamStack(opts.db);
    try { console.log(JSON.stringify(stack.service.list(), null, 2)); } finally { stack.close(); }
  });

team.command('show <id>')
  .description('Show a team: draft, validation report, published versions')
  .option('--db <path>', 'SQLite path', defaultDbPath())
  .action(async (id: string, opts: { db: string }) => {
    const stack = await openTeamStack(opts.db);
    try {
      const found = stack.service.get(id);
      if (!found) { console.error(`team not found: ${id}`); process.exitCode = 2; return; }
      console.log(JSON.stringify(found, null, 2));
    } finally { stack.close(); }
  });

team.command('run')
  .description('Start a team run pinned to the published version (waits for completion unless --no-wait)')
  .option('--team <id>', 'Published team id')
  .option('--definition <path>', 'Publish this definition file first, then run it')
  .requiredOption('--task <text>', 'Team objective')
  .option('--workflow <id>', 'Workflow id (defaults to the orchestration default)')
  .option('--workspace <path>', 'Run workspace inside the server workspace')
  .option('--max-duration-ms <n>', 'Wall-clock budget for the run')
  .option('--no-wait', 'Return immediately with the run id')
  .option('--follow', 'Print the live event timeline while waiting')
  .option('--output-format <fmt>', 'text|json', 'text')
  .option('--db <path>', 'SQLite path', defaultDbPath())
  .action(async (opts: { team?: string; definition?: string; task: string; workflow?: string; workspace?: string; maxDurationMs?: string; wait: boolean; follow?: boolean; outputFormat: string; db: string }) => {
    const stack = await openTeamStack(opts.db);
    try {
      let systemId = opts.team;
      if (!systemId && opts.definition) {
        const json = JSON.parse(readFileSync(opts.definition, 'utf8')) as { metadata: { id: string } };
        systemId = json.metadata.id;
        const existing = stack.store.getSystem(systemId);
        const saved = existing ? stack.service.update(systemId, json) : stack.service.create(json);
        stack.service.publish(saved.id as string);
      }
      if (!systemId) { console.error('pass --team <id> or --definition <path>'); process.exitCode = 2; return; }
      const limits = opts.maxDurationMs ? { maxDurationMs: Number(opts.maxDurationMs) } : undefined;
      const started = stack.service.startRun(systemId, { task: opts.task, workflowId: opts.workflow, workspace: opts.workspace, limits });
      const runId = String(started.runId);
      if (!opts.wait) {
        console.log(JSON.stringify({ ...started, runId }, null, 2));
        return;
      }
      let after = 0;
      const deadline = Date.now() + (Number(opts.maxDurationMs) || 3 * 60 * 60_000) + 60_000;
      // This process owns the engine, so the engine — not the run row — is the source
      // of truth: an outside actor (a booting server's stale-run recovery) can flip
      // the row to `interrupted` while the run is still executing here. Wait for the
      // engine to actually settle, then read the final row.
      const settled = stack.service.settled(runId);
      let engineSettled = false;
      void settled.then(() => { engineSettled = true; }, () => { engineSettled = true; });
      while (!engineSettled) {
        if (Date.now() > deadline) { console.error(`timed out waiting for ${runId}; it keeps running in the background`); process.exitCode = 3; break; }
        await Promise.race([settled, new Promise((r) => setTimeout(r, 1200))]);
        if (opts.follow) {
          for (const ev of stack.store.listEvents(runId, after)) {
            after = ev.seq;
            const who = ev.memberId ? ` ${ev.memberId}` : '';
            console.error(`[${ev.seq}]${who} ${ev.kind} ${JSON.stringify(ev.payload).slice(0, 220)}`);
          }
        }
      }
      // The run row turns terminal just before the engine appends its closing events;
      // wait for those writes so the summary is complete and closing the database
      // cannot pull it out from under an in-flight write.
      if (!engineSettled) await Promise.race([settled, new Promise((r) => setTimeout(r, 60_000))]);
      let run = stack.store.getSystemRun(runId);
      const artifacts = stack.store.listArtifacts(runId);
      const handoffs = stack.store.listHandoffs(runId);
      const summary = { runId, status: run?.status, error: run?.error ?? null, workspace: run?.workspace, artifacts: artifacts.map((a) => ({ id: a.id, type: a.type, name: a.name, version: a.version, path: a.path })), handoffs: handoffs.map((h) => ({ id: h.id, from: h.from_member, to: h.to_member, status: h.status })) };
      if (opts.outputFormat === 'json') console.log(JSON.stringify(summary, null, 2));
      else {
        console.log(`status: ${String(run?.status)}${run?.error ? ` — ${String(run.error)}` : ''}`);
        for (const a of artifacts) console.log(`artifact: ${a.type} ${a.name} v${a.version} (${a.id})`);
        for (const h of handoffs) console.log(`handoff: ${h.from_member} → ${h.to_member} [${h.status}]`);
        console.log(`run: ${runId}`);
      }
      if (run?.status !== 'done') process.exitCode = 3;
    } catch (e) {
      console.error(`team run failed: ${(e as Error).message}`);
      process.exitCode = 3;
    } finally { stack.close(); }
  });

team.command('status <runId>')
  .description('Run status, nodes, artifacts and handoffs')
  .option('--db <path>', 'SQLite path', defaultDbPath())
  .action(async (runId: string, opts: { db: string }) => {
    const stack = await openTeamStack(opts.db);
    try {
      const run = stack.store.getSystemRun(runId);
      if (!run) { console.error(`team run not found: ${runId}`); process.exitCode = 2; return; }
      console.log(JSON.stringify({
        run: { ...run, snapshot_json: undefined, limits_json: undefined },
        nodes: stack.store.listNodeRuns(runId),
        messages: stack.store.listMessages(runId, { limit: 200 }),
        artifacts: stack.store.listArtifacts(runId),
        handoffs: stack.store.listHandoffs(runId),
        events: stack.store.listEvents(runId).slice(-50),
      }, null, 2));
    } finally { stack.close(); }
  });

team.command('stop <runId>')
  .description('Stop a team run (only works while this process is the one executing it)')
  .option('--db <path>', 'SQLite path', defaultDbPath())
  .action(async (runId: string, opts: { db: string }) => {
    const stack = await openTeamStack(opts.db);
    try { stack.service.stop(runId); console.log(`stop requested: ${runId}`); } catch (e) { console.error((e as Error).message); process.exitCode = 2; } finally { stack.close(); }
  });

team.command('resume <runId>')
  .description('Resume an interrupted run from its last persisted frontier')
  .option('--no-wait', 'Return immediately after resuming')
  .option('--follow', 'Print the live event timeline while waiting')
  .option('--output-format <fmt>', 'text|json', 'text')
  .option('--db <path>', 'SQLite path', defaultDbPath())
  .action(async (runId: string, opts: { wait: boolean; follow?: boolean; outputFormat: string; db: string }) => {
    const stack = await openTeamStack(opts.db);
    try {
      stack.service.resume(runId);
      if (!opts.wait) { console.log(`resumed: ${runId}`); return; }
      // The engine keeps executing in this process, so the CLI must hold the run
      // (and its SQLite handle) open until the run reaches a terminal state.
      console.log(`resumed: ${runId}`);
      let after = 0;
      // Same contract as `team run`: this process owns the engine, so wait for the
      // engine itself, not the run row (see the waiter in `team run`).
      const settled = stack.service.settled(runId);
      let engineSettled = false;
      void settled.then(() => { engineSettled = true; }, () => { engineSettled = true; });
      while (!engineSettled) {
        await Promise.race([settled, new Promise((r) => setTimeout(r, 1200))]);
        if (opts.follow) {
          for (const ev of stack.store.listEvents(runId, after)) {
            after = ev.seq;
            const who = ev.memberId ? ` ${ev.memberId}` : '';
            console.error(`[${ev.seq}]${who} ${ev.kind} ${JSON.stringify(ev.payload).slice(0, 220)}`);
          }
        }
      }
      if (!engineSettled) await Promise.race([settled, new Promise((r) => setTimeout(r, 60_000))]);
      const run = stack.store.getSystemRun(runId);
      const artifacts = stack.store.listArtifacts(runId);
      const summary = { runId, status: run?.status, error: run?.error ?? null, workspace: run?.workspace, artifacts: artifacts.map((a) => ({ id: a.id, type: a.type, name: a.name, version: a.version, path: a.path })) };
      if (opts.outputFormat === 'json') console.log(JSON.stringify(summary, null, 2));
      else {
        console.log(`status: ${String(run?.status)}${run?.error ? ` — ${String(run.error)}` : ''}`);
        for (const a of artifacts) console.log(`artifact: ${a.type} ${a.name} v${a.version} (${a.id})`);
      }
      if (run?.status !== 'done') process.exitCode = 3;
    } catch (e) { console.error((e as Error).message); process.exitCode = 2; } finally { stack.close(); }
  });

team.command('export <runId>')
  .description('Write the complete run bundle (snapshot, nodes, messages, artifacts, events) to a file')
  .option('--out <path>', 'Output path (default: ./team-run-<id>.json)')
  .option('--db <path>', 'SQLite path', defaultDbPath())
  .action(async (runId: string, opts: { out?: string; db: string }) => {
    const stack = await openTeamStack(opts.db);
    try {
      const bundle = stack.service.exportRun(runId);
      if (!bundle) { console.error(`team run not found: ${runId}`); process.exitCode = 2; return; }
      const out = resolve(opts.out ?? `./team-run-${runId}.json`);
      writeFileSync(out, JSON.stringify(bundle, null, 2));
      console.log(`exported: ${out}`);
    } finally { stack.close(); }
  });

// ---------------- onboarding + handover ----------------
program.command('init')
  .description('First-run setup: choose an LLM provider, store its key encrypted, verify it, and seed the starter agents')
  .option('--db <path>', 'SQLite path', defaultDbPath())
  .option('--provider <preset>', `Preset: ${'xiaomi|openai|anthropic|ollama|custom'}`)
  .option('--name <name>', 'Provider display name')
  .option('--base-url <url>', 'OpenAI-compatible base URL (must end in /v1 for most providers)')
  .option('--model <model>', 'Default model')
  .option('--api-key-env <var>', 'Read the API key from this environment variable (never from argv)')
  .option('--api-key-stdin', 'Read the API key from the first stdin line (never from argv)')
  .option('--skip-test', 'Save without probing /models')
  .option('--no-seed-agents', 'Do not register the shipped role agents and sample team')
  .option('--json', 'Machine-readable output')
  .option('--postinstall', 'npm lifecycle mode: prompt only on a first interactive local install')
  .action(async (opts: { db: string; provider?: string; name?: string; baseUrl?: string; model?: string; apiKeyEnv?: string; apiKeyStdin?: boolean; skipTest?: boolean; seedAgents: boolean; json?: boolean; postinstall?: boolean }) => {
    if (opts.postinstall) { await postinstallInit(); return; }
    try {
      let apiKey = opts.apiKeyEnv ? process.env[opts.apiKeyEnv] : undefined;
      if (opts.apiKeyEnv && !apiKey) throw new Error(`Environment variable ${opts.apiKeyEnv} is not set.`);
      if (!apiKey && opts.apiKeyStdin) {
        apiKey = await new Promise<string>((resolvePromise) => {
          let data = '';
          process.stdin.setEncoding('utf8');
          process.stdin.on('data', (chunk) => { data += chunk; });
          process.stdin.on('end', () => resolvePromise((data.split(/\r?\n/)[0] ?? '').trim()));
        });
        if (!apiKey) throw new Error('No API key received on stdin.');
      }
      const outcome = await runSetupWizard({
        dbPath: opts.db,
        provider: opts.provider,
        name: opts.name,
        baseUrl: opts.baseUrl,
        model: opts.model,
        apiKey,
        skipTest: opts.skipTest,
        seedAgents: opts.seedAgents,
        interactive: process.stdin.isTTY && process.stdout.isTTY,
      });
      if (outcome === 'browser' || outcome === 'flags') return;
      const result = outcome;
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`provider: ${result.providerName} (${result.providerId})`);
        console.log(`endpoint: ${result.baseUrl}`);
        console.log(`model: ${result.model}`);
        console.log(`connection: ${result.tested ? `ok (${result.models.length} models discovered)` : 'not tested'}`);
        console.log(`starter agents: ${result.seededAgents.length ? result.seededAgents.join(', ') : 'none'}`);
        console.log(`sample teams: ${result.seededTeams.length ? result.seededTeams.map((t) => `${t.id}@${t.version}`).join(', ') : 'none'}`);
        console.log(`database: ${result.dbPath}`);
        console.log('next: minions-ai ui');
      }
    } catch (e) {
      console.error(`init failed: ${(e as Error).message}`);
      process.exitCode = 2;
    }
  });

program.command('reset')
  .description('Reset runtime state to a new installation: runs, chats, memories and provider keys; optionally reseed the starter agent and sample team')
  .option('--db <path>', 'SQLite path', defaultDbPath())
  .option('--workspace <path>', 'Server workspace root (team workspaces live under <root>/teams)')
  .option('--data-dir <path>', 'Directory holding .master-key (default: MINIONS_DATA_DIR or the platform data dir)')
  .option('--new-install', 'Also delete .master-key so the next init generates a fresh key')
  .option('--no-backup', 'Skip the pre-reset database copy')
  .option('--no-seed-defaults', 'Do not re-register the starter agent and sample team')
  .option('--yes', 'Required: confirms the destructive reset')
  .option('--json', 'Machine-readable output')
  .action((opts: { db: string; workspace?: string; dataDir?: string; newInstall?: boolean; backup: boolean; seedDefaults: boolean; yes?: boolean; json?: boolean }) => {
    if (!opts.yes) {
      console.error('reset is destructive; pass --yes to confirm. A backup is made by default (--no-backup to skip).');
      process.exitCode = 2;
      return;
    }
    try {
      const result = resetDatabase({
        dbPath: opts.db,
        workspaceRoot: opts.workspace ?? resolveWorkspace().root,
        dataDir: opts.dataDir,
        newInstall: opts.newInstall,
        seedDefaults: opts.seedDefaults,
        backup: opts.backup,
      });
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`database: ${result.dbPath}`);
        if (result.backupPath) console.log(`backup: ${result.backupPath}`);
        const wiped = Object.entries(result.tables).filter(([, n]) => n > 0);
        console.log(`wiped: ${wiped.length ? wiped.map(([t, n]) => `${t}=${n}`).join(', ') : 'already empty'}`);
        for (const p of result.removedPaths) console.log(`removed: ${p}`);
        if (result.masterKeyRemoved) console.log('removed: .master-key (fresh encryption key on next init)');
        console.log(`starter agents: ${result.seededAgents.length ? result.seededAgents.join(', ') : 'none'}`);
        console.log(`sample teams: ${result.seededTeams.length ? result.seededTeams.map((t) => `${t.id}@${t.version}`).join(', ') : 'none'}`);
        console.log('state: new installation — no runs, chats or memories');
      }
    } catch (e) {
      console.error(`reset failed: ${(e as Error).message}`);
      process.exitCode = 2;
    }
  });

// ---------------- A2A inspection ----------------
const a2a = team.command('a2a').description('Inspect the Agent2Agent surface for a team or run');
a2a.command('card <teamId>')
  .description('Print the A2A agent card for a team')
  .option('--base-url <url>', 'Base URL used in the card', 'http://127.0.0.1:3100')
  .option('--db <path>', 'SQLite path', defaultDbPath())
  .action(async (teamId: string, opts: { baseUrl: string; db: string }) => {
    const stack = await openTeamStack(opts.db);
    try {
      const system = stack.store.getSystem(teamId);
      if (!system) { console.error(`team not found: ${teamId}`); process.exitCode = 2; return; }
      console.log(JSON.stringify(teamCard(opts.baseUrl, system), null, 2));
    } finally { stack.close(); }
  });
a2a.command('task <runId>')
  .description('Print a team run as an A2A Task (status, artifacts, history, progress)')
  .option('--db <path>', 'SQLite path', defaultDbPath())
  .action(async (runId: string, opts: { db: string }) => {
    const stack = await openTeamStack(opts.db);
    try {
      const run = stack.store.getSystemRun(runId);
      if (!run) { console.error(`team run not found: ${runId}`); process.exitCode = 2; return; }
      console.log(JSON.stringify(buildTask(stack.store, run as never, { includeArtifactContent: false }), null, 2));
    } finally { stack.close(); }
  });

// Parse argv only when actually run as the CLI entrypoint (`node dist/cli.js …`,
// `tsx src/cli.ts …`) or through the npm bin symlink (`minions-ai …`).
// Compare real paths: the symlink is named `minions-ai`, not `cli.js`, and
// the old basename check silently did nothing for every globally installed CLI.
// When imported by tests, program.parseAsync would read vitest's argv and call
// commander's help→exit(1), aborting the test run.
function isCliEntrypoint(): boolean {
  if (process.env.MINIONS_EXE === '1' || Boolean((process as unknown as { pkg?: unknown }).pkg)) return true;
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const real = (p: string) => { try { return realpathSync(p).replace(/\\/g, '/'); } catch { return p.replace(/\\/g, '/'); } };
  const self = real(moduleFile(import.meta.url));
  return real(argv1) === self && /cli\.(ts|js)$/.test(self);
}
if (isCliEntrypoint()) void program.parseAsync(process.argv);
