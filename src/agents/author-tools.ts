/**
 * Platform authoring tools for the built-in chat designers (`agent-author@builtin`,
 * `team-author@builtin`). A chat turn with these tools can interview the user,
 * validate a definition against the real schema, and save it into the registry —
 * the same code path as `POST /api/agents` and `TeamService.create/publish`.
 *
 * These tools are injected ONLY for the two builtin author agents; user-defined
 * agents never see them. Every save is audited through `onToolEvent`.
 */
import type { DbAdapter } from '../store/adapter.js';
import type { PlatformStore } from '../store/platform.js';
import type { TeamService } from '../systems/service.js';
import { validateDefinitionObject } from './loader.js';
import { BUILTIN_TOOLS, BUILTIN_TOOLS_SOURCE } from './tools-policy.js';
import { sealDefinitionSecrets } from './provider-keys.js';
import { validateSystemDefinition, hashDefinition } from '../systems/schema.js';
import { resolverFor } from '../systems/resolver.js';
import { validateTeam } from '../systems/validate.js';

interface ToolLike {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
  skipPermission?: boolean;
  defer?: 'never';
}

export interface AuthorToolContext {
  db: DbAdapter;
  platform: PlatformStore;
  /** Team service factory — only wired for the team designer. */
  teams?: () => TeamService;
  onToolEvent?: (type: string, payload: Record<string, unknown>) => void;
}

const ok = (v: unknown) => JSON.stringify(v);
const fail = (e: unknown) => ok({ valid: false, error: (e as Error).message });

/** Tools shared by both designers: discovery of what the registry offers. */
export function buildDiscoveryTools(ctx: AuthorToolContext): ToolLike[] {
  const log = (type: string, payload: Record<string, unknown>) => { try { ctx.onToolEvent?.(type, payload); } catch { /* best-effort */ } };
  return [
    {
      name: 'list_registered_agents',
      description: 'List every agent registered in this platform (id, name, version, description). Use this when composing a team so members pin real agents.',
      parameters: { type: 'object', properties: {} },
      skipPermission: true,
      defer: 'never',
      handler: async () => {
        log('author.list_agents', {});
        return ok({ agents: ctx.db.listAgents('all').map((a) => {
          let description = '';
          try {
            const row = ctx.db.getAgent(a.id) as { definition_json?: string } | undefined;
            description = String((JSON.parse(String(row?.definition_json ?? '{}')) as { metadata?: { description?: string } }).metadata?.description ?? '');
          } catch { /* malformed row */ }
          return { id: a.id, name: a.name, version: a.version, status: a.status, description };
        }) });
      },
    },
    {
      name: 'list_mcp_servers',
      description: 'List MCP servers registered in this platform (name, description, discovered tools). Reference them from a definition via mcp.use.',
      parameters: { type: 'object', properties: {} },
      skipPermission: true,
      defer: 'never',
      handler: async () => {
        log('author.list_mcp', {});
        return ok({ servers: ctx.db.listMcpServers().map((s) => {
          let tools: string[] = [];
          try { tools = (JSON.parse(s.tools_json ?? '[]') as { name: string }[]).map((t) => t.name); } catch { /* ignore */ }
          return { name: s.name, description: s.description, tools };
        }) });
      },
    },
    {
      name: 'list_builtin_tools',
      description: 'List the built-in tools an agent definition can allow or deny (bash, read, write, edit, grep, glob, task, skill, …) with their groups.',
      parameters: { type: 'object', properties: {} },
      skipPermission: true,
      defer: 'never',
      handler: async () => {
        log('author.list_tools', {});
        return ok({ source: BUILTIN_TOOLS_SOURCE, tools: BUILTIN_TOOLS });
      },
    },
  ];
}

/** Agent-definition tools for `agent-author@builtin`. */
export function buildAgentAuthorTools(ctx: AuthorToolContext): ToolLike[] {
  const log = (type: string, payload: Record<string, unknown>) => { try { ctx.onToolEvent?.(type, payload); } catch { /* best-effort */ } };
  const definitionSchema = {
    type: 'object',
    description: 'A complete AgentDefinition (schemaVersion 1.0) — metadata, persona, instructions, tools, mcp, provider, runtime.',
  };
  return [
    ...buildDiscoveryTools(ctx),
    {
      name: 'validate_agent_definition',
      description: 'Validate an agent definition against the platform schema WITHOUT saving. Returns {valid, hash, warnings} or {valid:false, error}. Always run this before saving.',
      parameters: { type: 'object', properties: { definition: definitionSchema }, required: ['definition'] },
      skipPermission: true,
      defer: 'never',
      handler: async (args) => {
        try {
          const load = validateDefinitionObject(args.definition);
          log('author.validate_agent', { hash: load.definitionHash });
          return ok({ valid: true, hash: load.definitionHash, warnings: load.warnings });
        } catch (e) { return fail(e); }
      },
    },
    {
      name: 'save_agent_definition',
      description: 'Validate and save an agent definition into the registry (same as POST /api/agents). Optionally override metadata.name/version first — the name becomes the agent id and should be a short slug. Returns {id, hash, warnings}.',
      parameters: {
        type: 'object',
        properties: {
          definition: definitionSchema,
          name: { type: 'string', description: 'Optional metadata.name override (slug)' },
          version: { type: 'string', description: 'Optional metadata.version override (semver)' },
        },
        required: ['definition'],
      },
      skipPermission: true,
      defer: 'never',
      handler: async (args) => {
        try {
          const input = { ...(args.definition as Record<string, unknown>) } as Record<string, unknown>;
          const meta = { ...((input.metadata ?? {}) as Record<string, unknown>) };
          if (args.name) meta.name = String(args.name);
          if (args.version) meta.version = String(args.version);
          input.metadata = meta;
          const load = validateDefinitionObject(input);
          const sealed = sealDefinitionSecrets(load.definition);
          const id = ctx.db.saveAgent(sealed.metadata.name, sealed.metadata.version, JSON.stringify(sealed), load.definitionHash);
          log('author.save_agent', { id, hash: load.definitionHash });
          return ok({ id, hash: load.definitionHash, warnings: load.warnings });
        } catch (e) { return fail(e); }
      },
    },
  ];
}

/** Agent-system tools for `team-author@builtin`. */
export function buildTeamAuthorTools(ctx: AuthorToolContext): ToolLike[] {
  const log = (type: string, payload: Record<string, unknown>) => { try { ctx.onToolEvent?.(type, payload); } catch { /* best-effort */ } };
  return [
    ...buildDiscoveryTools(ctx),
    {
      name: 'validate_agent_system',
      description: 'Validate an agent-system (team) definition without saving: schema, member pins against the registry, and workflow graphs. Returns {valid, hash, warnings, errors}.',
      parameters: {
        type: 'object',
        properties: { definition: { type: 'object', description: 'A complete AgentSystemDefinition (kind: agent-system)' } },
        required: ['definition'],
      },
      skipPermission: true,
      defer: 'never',
      handler: async (args) => {
        try {
          const { definition } = validateSystemDefinition(args.definition);
          const report = validateTeam(definition, { resolveAgent: resolverFor(ctx.db) });
          log('author.validate_team', { ok: report.ok });
          return ok({ valid: report.ok, errors: report.errors, warnings: report.warnings, hash: hashDefinition(definition) });
        } catch (e) { return fail(e); }
      },
    },
    {
      name: 'save_agent_system',
      description: 'Validate, save and optionally publish a team definition (same as POST /api/teams + publish). Member agentRefs are pinned to the registered definitions automatically. The metadata.id becomes the team id (short slug). Returns {id, version, published}.',
      parameters: {
        type: 'object',
        properties: {
          definition: { type: 'object', description: 'A complete AgentSystemDefinition (kind: agent-system)' },
          publish: { type: 'boolean', description: 'Publish an immutable runnable version (default true)' },
          version: { type: 'string', description: 'Optional version override for this publish' },
        },
        required: ['definition'],
      },
      skipPermission: true,
      defer: 'never',
      handler: async (args) => {
        try {
          const teams = ctx.teams?.();
          if (!teams) return ok({ valid: false, error: 'team authoring is not available in this session' });
          const def = args.definition as { metadata?: { id?: string } };
          const systemId = String(def.metadata?.id ?? '');
          if (!systemId) return ok({ valid: false, error: 'metadata.id is required' });
          const existing = teams.get(systemId);
          const saved = existing ? teams.update(systemId, def) : teams.create(def);
          let version: string | null = null;
          if (args.publish !== false) {
            const pub = teams.publish(saved.id as string, args.version ? String(args.version) : undefined) as { currentVersion?: string };
            version = pub.currentVersion ?? null;
          }
          log('author.save_team', { id: systemId, version });
          return ok({ id: systemId, version, published: args.publish !== false });
        } catch (e) { return fail(e); }
      },
    },
  ];
}
