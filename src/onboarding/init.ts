import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { SqliteAdapter } from '../store/sqlite.js';
import { TeamStore } from '../store/teams.js';
import { PlatformStore, type ProviderRow } from '../store/platform.js';
import { loadAgentDefinition, validateDefinitionObject } from '../agents/loader.js';
import { providerAuthHeaders } from '../agents/provider-keys.js';
import { hashDefinition, validateSystemDefinition } from '../systems/schema.js';
import { ensureAssets } from '../core/embedded-assets.js';
import { isPackaged } from '../core/install-paths.js';
import { moduleDir } from '../core/module-path.js';
import { resolveTeamMembers, resolverFor } from '../systems/resolver.js';
import { validateTeam } from '../systems/validate.js';
import type { AgentSystemDefinition } from '../systems/types.js';

export interface ProviderPreset {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  type: 'openai' | 'anthropic';
  needsKey: boolean;
  hint: string;
}

/** Presets only fill the prompts; every value remains editable. */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'xiaomi', name: 'Xiaomi MiMo', baseUrl: 'https://api.xiaomimimo.com/v1',
    model: 'mimo-v2.6-flash', type: 'openai', needsKey: true,
    hint: 'OpenAI-compatible MiMo endpoint (the provider used by the shipped starter agents).',
  },
  {
    id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1', type: 'openai', needsKey: true,
    hint: 'Official OpenAI API.',
  },
  {
    id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-4-5', type: 'anthropic', needsKey: true,
    hint: 'Anthropic Messages API through the Copilot runtime.',
  },
  {
    id: 'ollama', name: 'Ollama (local)', baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'llama3.2', type: 'openai', needsKey: false,
    hint: 'Local OpenAI-compatible server; no key required.',
  },
  {
    id: 'custom', name: 'Custom OpenAI-compatible', baseUrl: '',
    model: '', type: 'openai', needsKey: true,
    hint: 'Any endpoint that implements /chat/completions.',
  },
];

export interface InitOptions {
  dbPath: string;
  provider?: string;
  name?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  skipTest?: boolean;
  interactive?: boolean;
  json?: boolean;
  seedAgents?: boolean;
}

export interface InitResult {
  created: boolean;
  providerId: string;
  providerName: string;
  baseUrl: string;
  model: string;
  type: string;
  tested: boolean;
  models: string[];
  seededAgents: string[];
  seededTeams: SeededTeam[];
  dbPath: string;
}

const here = moduleDir(import.meta.url);

/**
 * Locate the shipped examples in a source checkout and in the packed artifact.
 *
 * The shipped sample set is deliberately flat: one base agent and one sample agent
 * team at `examples/`. `examples/agents/` is still probed so a checkout that keeps
 * extra specialists (or an older install) keeps seeding them.
 */
export function findExamplesRoot(): string | undefined {
  const explicit = process.env.MINIONS_EXAMPLES_ROOT?.trim();
  if (explicit && existsSync(explicit)) return explicit;
  if (isPackaged()) {
    try { const root = ensureAssets('examples'); if (existsSync(root)) return root; } catch { /* fall through */ }
  }
  const candidates = [
    resolve(here, '..', '..', 'examples'),              // dist/onboarding or src/onboarding
    resolve(here, '..', '..', '..', 'examples'),
    resolve(process.cwd(), 'examples'),
  ];
  return candidates.find((p) => existsSync(p));
}

/** Every `*.agent.json` the installer should seed, flat first then one nested folder. */
export function listExampleAgents(root: string): string[] {
  const flat = readdirSync(root).filter((f) => f.endsWith('.agent.json')).sort();
  const nested = readdirSync(root)
    .filter((entry) => { try { return statSync(join(root, entry)).isDirectory(); } catch { return false; } })
    .sort()
    .flatMap((dir) => readdirSync(join(root, dir)).filter((f) => f.endsWith('.agent.json')).sort().map((f) => join(dir, f)));
  return [...flat, ...nested];
}

/** Every `*.agent-system.json` the installer should seed and publish. */
export function listExampleTeams(root: string): string[] {
  return readdirSync(root).filter((f) => f.endsWith('.agent-system.json')).sort();
}

/** Register the shipped starter agents. With a provider they are pinned to it. */
export function seedStarterAgents(db: SqliteAdapter, provider?: ProviderRow): string[] {
  const root = findExamplesRoot();
  if (!root) return [];
  const seeded: string[] = [];
  for (const file of listExampleAgents(root)) {
    try {
      const loaded = loadAgentDefinition(join(root, file));
      const definition = loaded.definition;
      if (provider) {
        definition.provider = {
          providerRef: provider.id,
          type: (provider.type === 'anthropic' ? 'anthropic' : 'openai'),
          baseUrl: provider.baseUrl,
          model: definition.provider.model || provider.defaultModel || '',
          providerApiKey: 'provider-ref',
          ...(provider.wireApi ? { wireApi: provider.wireApi as 'completions' | 'responses' } : {}),
          ...(provider.azureApiVersion ? { azureApiVersion: provider.azureApiVersion } : {}),
        };
      }
      const validated = validateDefinitionObject(definition);
      db.saveAgent(
        validated.definition.metadata.name,
        validated.definition.metadata.version,
        JSON.stringify(validated.definition),
        validated.definitionHash,
      );
      seeded.push(`${validated.definition.metadata.name}@${validated.definition.metadata.version}`);
    } catch {
      // A malformed local example must not block onboarding; the doctor/validate
      // commands surface it if the user goes looking.
    }
  }
  return seeded;
}

export interface SeededTeam { id: string; version: string; members: number }

/**
 * Register and publish the shipped sample agent team.
 *
 * A fresh install must be able to run the sample team without editing JSON. The
 * sample file pins the hash of the *file*, but the agent registered here differs
 * from that file by one block — its provider — so the pin is rewritten to the
 * definition that actually lives in this database. Publishing then snapshots an
 * immutable version exactly as the API does; later edits to an agent never change
 * this version.
 */
export function seedSampleTeams(db: SqliteAdapter): SeededTeam[] {
  const root = findExamplesRoot();
  if (!root) return [];
  const store = new TeamStore(db);
  const seeded: SeededTeam[] = [];
  for (const file of listExampleTeams(root)) {
    try {
      const definition = JSON.parse(readFileSync(join(root, file), 'utf8')) as AgentSystemDefinition;
      for (const member of definition.team.members) {
        const wanted = member.agentRef.agentId;
        const name = wanted.includes('@') ? wanted.slice(0, wanted.lastIndexOf('@')) : wanted;
        const row = db.getAgent(wanted)
          ?? db.listAgents('all').map((a) => db.getAgent(a.id)).find((a) => a?.name === name);
        if (!row) continue;
        member.agentRef.agentId = row.id;
        member.agentRef.version = row.version;
        if (row.definition_hash) member.agentRef.definitionHash = `sha256:${row.definition_hash}`;
      }
      const checked = validateSystemDefinition(definition);
      const report = validateTeam(checked.definition, { resolveAgent: resolverFor(db) });
      if (!report.ok) continue;
      const systemId = checked.definition.metadata.id;
      const version = checked.definition.metadata.version;
      const definitionJson = JSON.stringify(checked.definition);
      const hash = hashDefinition(checked.definition);
      const publishedAt = new Date().toISOString();
      store.saveSystem({
        id: systemId, name: checked.definition.metadata.name,
        description: checked.definition.metadata.description ?? null,
        status: 'draft', definitionJson, hash, version: null,
      });
      store.publishSystemVersion({ systemId, version, definitionJson, definitionHash: hash, publishedAt });
      for (const workflow of checked.definition.orchestration.workflows) {
        store.saveWorkflowVersion({
          systemId, workflowId: workflow.workflowId, version: workflow.version ?? version,
          definitionJson: JSON.stringify(workflow), definitionHash: hashDefinition(workflow), createdAt: publishedAt,
        });
      }
      seeded.push({ id: systemId, version, members: checked.definition.team.members.length });
    } catch {
      // Same contract as agents: a broken sample must not block first-run setup.
    }
  }
  return seeded;
}

async function readPipedLine(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
  try {
    return (await rl.question('')).trim();
  } finally {
    rl.close();
  }
}

async function readHiddenLine(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    process.stderr.write(prompt);
    const value = await readPipedLine();
    process.stderr.write('\n');
    return value;
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  let hidden = true;
  const raw = rl as unknown as { _writeToOutput?: (s: string) => void };
  const original = raw._writeToOutput?.bind(rl);
  raw._writeToOutput = (s: string) => { if (!hidden && original) original(s); };
  try {
    const value = await rl.question(prompt);
    process.stderr.write('\n');
    hidden = false;
    return value.trim();
  } finally {
    rl.close();
  }
}

async function readAnswer(prompt: string, fallback: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: process.stdin.isTTY });
  try {
    const suffix = fallback ? ` [${fallback}]` : '';
    const value = (await rl.question(`${prompt}${suffix}: `)).trim();
    return value || fallback;
  } finally {
    rl.close();
  }
}

async function readSecret(prompt: string): Promise<string> {
  const value = await readHiddenLine(prompt);
  if (!value) throw new Error('An API key is required (or pass --api-key-env / --api-key-stdin).');
  return value;
}

export async function probeProvider(baseUrl: string, type: string, apiKey: string): Promise<string[]> {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  const res = await fetch(url, { headers: providerAuthHeaders(type, apiKey), signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Provider returned HTTP ${res.status} for GET ${url}: ${text.slice(0, 300)}`);
  }
  let models: string[] = [];
  try {
    const body = JSON.parse(text) as { data?: { id?: string; name?: string }[]; models?: { id?: string; name?: string }[] };
    models = (body.data ?? body.models ?? []).map((m) => String(m.id ?? m.name ?? '')).filter(Boolean);
  } catch { /* a non-JSON 200 is still a reachable endpoint */ }
  return models;
}

function presetOf(id: string | undefined): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}

/** Interactive/non-interactive first-run setup. Idempotent: updates the named provider if present. */
export async function runInit(opts: InitOptions): Promise<InitResult> {
  const interactive = opts.interactive ?? (!process.stdin.isTTY ? false : true);
  const presetId = opts.provider ?? (interactive ? await choosePreset() : 'custom');
  const preset = presetOf(presetId);
  if (opts.provider && !preset) throw new Error(`Unknown provider preset '${opts.provider}'. Choose one of: ${PROVIDER_PRESETS.map((p) => p.id).join(', ')}`);
  if (!preset) throw new Error(`Unknown provider preset '${presetId}'`);

  const baseUrl = opts.baseUrl ?? (interactive ? await readAnswer('Base URL (OpenAI-compatible /v1)', preset.baseUrl) : preset.baseUrl);
  if (!baseUrl) throw new Error('A provider base URL is required (--base-url).');
  try { new URL(baseUrl); } catch { throw new Error(`Invalid base URL: ${baseUrl}`); }
  const model = opts.model ?? (interactive ? await readAnswer('Default model', preset.model) : preset.model);
  if (!model) throw new Error('A default model is required (--model).');

  let apiKey = opts.apiKey?.trim();
  if (!apiKey && preset.needsKey) {
    if (!interactive) throw new Error('An API key is required: pass --api-key-env NAME or --api-key-stdin.');
    process.stderr.write(`\nConfigure ${preset.name}. The key is stored encrypted in the local database and never printed.\n`);
    apiKey = await readSecret('API key (input hidden): ');
  }
  apiKey ||= '';

  let tested = false;
  let models: string[] = [];
  if (!opts.skipTest) {
    try {
      models = await probeProvider(baseUrl, preset.type, apiKey);
      tested = true;
    } catch (err) {
      if (!interactive) throw err;
      process.stderr.write(`\nProvider test failed: ${(err as Error).message}\n`);
      const proceed = await readAnswer('Save it anyway? (y/N)', 'n');
      if (!/^y(es)?$/i.test(proceed)) throw err;
    }
  }

  const db = new SqliteAdapter(opts.dbPath);
  try {
    const platform = new PlatformStore(db);
    const all = platform.listProviders();
    const wantedName = (opts.name ?? preset.name).toLowerCase();
    const existing = all.find((p) => p.name.toLowerCase() === wantedName)
      ?? (all.length === 1 ? all[0] : undefined);
    let provider: ProviderRow;
    let created = false;
    if (existing) {
      provider = platform.updateProvider(existing.id, {
        name: opts.name ?? preset.name, type: preset.type, baseUrl, defaultModel: model,
        ...(apiKey ? { apiKey } : {}),
      })!;
      platform.setDefaultProvider(provider.id);
    } else {
      provider = platform.createProvider({
        name: opts.name ?? preset.name, type: preset.type, baseUrl, defaultModel: model,
        ...(apiKey ? { apiKey } : {}), makeDefault: true,
      });
      created = true;
    }
    platform.updateSettings({
      onboarding: { completed: true },
      defaults: { providerId: provider.id, model },
    });
    const seededAgents = opts.seedAgents === false ? [] : seedStarterAgents(db, provider);
    const seededTeams = opts.seedAgents === false ? [] : seedSampleTeams(db);
    return {
      created, providerId: provider.id, providerName: provider.name,
      baseUrl: provider.baseUrl, model, type: provider.type,
      tested, models: models.slice(0, 50), seededAgents, seededTeams, dbPath: opts.dbPath,
    };
  } finally {
    db.close();
  }
}

async function choosePreset(): Promise<string> {
  process.stderr.write('\nMinions-ai — first-run setup\n\nChoose a base provider:\n');
  PROVIDER_PRESETS.forEach((p, i) => process.stderr.write(`  ${i + 1}. ${p.name}${p.baseUrl ? ` — ${p.baseUrl}` : ''}\n     ${p.hint}\n`));
  const answer = await readAnswer(`\nProvider [1-${PROVIDER_PRESETS.length}]`, '1');
  const index = Number(answer) - 1;
  return PROVIDER_PRESETS[index]?.id ?? 'xiaomi';
}

/** npm postinstall entry: prompt only for a first local install, never break the install. */
export async function postinstallInit(): Promise<void> {
  try {
    if (process.env.CI || process.env.MINIONS_SKIP_INIT === '1' || !process.stdin.isTTY || !process.stdout.isTTY) return;
    const initCwd = process.env.INIT_CWD?.trim();
    if (!initCwd) return;
    // Installing the package inside its own checkout is development, not first-run.
    try {
      const pkg = JSON.parse(readFileSync(resolve(initCwd, 'package.json'), 'utf8')) as { name?: string };
      if (pkg.name === 'minions-assembler' || pkg.name === 'minions-ai') return;
    } catch { /* no package.json at INIT_CWD; still a valid project folder */ }
    const dbPath = resolve(initCwd, 'data', 'minion.db');
    if (existsSync(dbPath)) {
      const db = new SqliteAdapter(dbPath);
      try {
        if (new PlatformStore(db).listProviders().length) return;
      } finally { db.close(); }
    }
    process.stderr.write('\nMinions-ai installed. Configure a provider now (Enter accepts defaults):\n');
    const result = await runInit({ dbPath, interactive: true });
    process.stderr.write(`\nConfigured ${result.providerName} (${result.model}). Start with: minions-ai ui\n\n`);
  } catch (err) {
    process.stderr.write(`\nFirst-run setup skipped: ${(err as Error).message}\nRun "minions-ai init" when ready.\n`);
  }
}

export function describePreset(p: ProviderPreset): string {
  return `${basename(p.id)} — ${p.name} (${p.baseUrl || 'custom URL'})`;
}
