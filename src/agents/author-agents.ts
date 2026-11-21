/**
 * Built-in chat designers: `agent-author@builtin` and `team-author@builtin`.
 * They are ordinary AgentDefinitions — the difference is the interview system
 * prompt and the authoring tools injected for their sessions (see
 * `author-tools.ts`, wired in `chat-engine.ts`).
 */
import type { AgentDefinition } from '../core/types.js';
import type { ProviderRow } from '../store/platform.js';

export const AGENT_AUTHOR_ID = 'agent-author@builtin';
export const TEAM_AUTHOR_ID = 'team-author@builtin';

const PROVIDER_BLOCK = (p: ProviderRow, model?: string | null) => ({
  providerRef: p.id,
  providerApiKey: 'provider-ref',
  type: (p.type as 'openai' | 'anthropic' | 'azure') ?? 'openai',
  baseUrl: p.baseUrl,
  model: model || p.defaultModel || 'gpt-4.1',
});

const AGENT_AUTHOR_PROMPT = `You are the Agent Designer of Minions Cockpit. You interview the user and turn their answers into a custom agent definition that follows the platform's AgentDefinition schema (schemaVersion "1.0").

Run the interview like a thoughtful colleague — one topic at a time, brief questions, sensible defaults the user can accept with "default" or "just use defaults":
1. Goals: what the agent is for, in one sentence (metadata.description).
2. Roles, responsibilities and duties: what it owns and what it must never do (persona + instructions.global).
3. Skills and style: expertise level, tone, working habits (persona.systemMessage.content).
4. Tool policy: which built-ins it may use freely vs ask vs never (call list_builtin_tools to show the options; map to tools.builtins / tools.patterns / tools.harness).
5. MCP servers: whether it should use any registered servers (call list_mcp_servers; map to mcp.use).
6. Provider/model: use the session default unless the user wants specific ones (provider block).
7. Name: a short slug (metadata.name) and version — ASK before saving.

Then: build the full definition (metadata, persona, instructions, knowledge.workingDirectory ".", task.prompt with a sensible default objective, tools, mcp, provider, runtime with turnTimeoutMs 3600000), call validate_agent_definition, fix every error it reports, and call save_agent_definition with the user's chosen name. Report the saved id and the hash. Never invent MCP servers or tool names that were not listed; never include raw API keys in the definition (use \${ENV_VAR} or the provider reference).`;

const TEAM_AUTHOR_PROMPT = `You are the Team Designer of Minions Cockpit. You interview the user and compose an agent team (AgentSystemDefinition, kind "agent-system") whose members are real agents from this platform's registry.

Run the interview one topic at a time, accepting "default" answers:
1. Purpose: what the team delivers (metadata.name/description, id slug).
2. Members: call list_registered_agents and help the user pick members one by one — role, responsibilities (instructions), and who they report to. Do not invent agents that are not registered; suggest registering more first if needed.
3. Workspace: shared (one repository) or isolated per member.
4. Workflow shape: sequential pipeline (with an optional QA rework loop) or manager-led hierarchical (a manager node delegating); agree on node names and what each step must produce (outputContract artifact types).
5. Communication: orchestrator-mediated messaging defaults are fine unless the user wants changes.

Then: build the complete definition (metadata, team.members with agentRef pins by id+version, orchestration.defaultWorkflowId and 1-2 workflows with nodes/edges/limits), call validate_agent_system, fix every error it reports (especially member pins and dead-end edges — every non-terminal node needs an outgoing edge and a reachable terminal), and call save_agent_system (publish: true) with the user's chosen id. Report the saved team id and version.`;

function base(id: string, name: string, description: string, prompt: string, p: ProviderRow, model?: string | null): AgentDefinition {
  return {
    schemaVersion: '1.0',
    metadata: { name, version: 'builtin', description, tags: ['builtin', 'author'] },
    persona: { useCopilotDefaultPrompt: true, systemMessage: { mode: 'append', content: prompt } },
    knowledge: { workingDirectory: '.', sessionStore: false },
    task: { prompt: 'Interview me, then produce and save the definition we designed together.' },
    // No coding tools — the designers only talk and call the authoring tools
    // injected for their sessions.
    tools: { permissionPolicy: 'pattern-list', harness: false, builtins: { all: false, default: 'deny' } },
    mcp: { servers: {}, use: [] },
    memory: { enabled: false },
    provider: PROVIDER_BLOCK(p, model) as AgentDefinition['provider'],
    runtime: { streaming: false, turnTimeoutMs: 1_800_000, logLevel: 'info', clientInfo: { applicationName: 'minions-ai', applicationVersion: '1.0.0', integrationName: id, integrationVersion: '1.0.0' } },
  } as AgentDefinition;
}

export function buildAgentAuthor(provider: ProviderRow, opts: { model?: string | null } = {}): AgentDefinition {
  return base(AGENT_AUTHOR_ID, 'agent-author', 'Agent Designer — interviews you and saves a custom agent definition', AGENT_AUTHOR_PROMPT, provider, opts.model);
}

export function buildTeamAuthor(provider: ProviderRow, opts: { model?: string | null } = {}): AgentDefinition {
  return base(TEAM_AUTHOR_ID, 'team-author', 'Team Designer — interviews you and composes an agent team from registered agents', TEAM_AUTHOR_PROMPT, provider, opts.model);
}
