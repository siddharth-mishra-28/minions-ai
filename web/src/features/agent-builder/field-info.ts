import { createElement, Fragment, type ReactNode } from 'react';

/** Beginner-friendly tooltip copy for one agent-builder field. */
export interface FieldInfo {
  summary: string;
  detail?: string;
}

/**
 * Tooltip copy for the custom agent builder, keyed by the semantic field path
 * used in the builder's `useField(...)` / `set(...)` calls. Wording is grounded
 * in src/core/types.ts and describes runtime behavior of the definition.
 */
export const FIELD_INFO: Record<string, FieldInfo> = {
  // ── Identity (metadata) ─────────────────────────────────────────────
  'metadata.name': {
    summary: 'The display name people see in the chat agent picker and anywhere the agent is listed.',
    detail: 'Together with the version it forms the agent id (name@version) used by the API and runs.',
  },
  'metadata.version': {
    summary: 'Semantic version of this definition, e.g. 1.0.0 — the second half of the agent id (name@version).',
    detail: 'Publishing under a new name or version creates a new agent and leaves existing runs untouched.',
  },
  'metadata.description': {
    summary: 'One or two sentences explaining what this agent is good at, shown wherever people choose an agent.',
    detail: 'Write it for the humans picking the agent; the system prompt is where the model gets its instructions.',
  },
  'metadata.color': {
    summary: "Tints this agent's messages in the chat transcript so they are easy to spot.",
    detail: 'Leave on Auto for a deterministic color derived from the name.',
  },
  'metadata.tags': {
    summary: 'Free-form labels for filtering and finding this agent later, e.g. review, typescript.',
  },

  // ── Provider & model ────────────────────────────────────────────────
  'provider.providerRef': {
    summary: 'Points at a provider configured in Settings (OpenAI, Anthropic, Azure, Ollama…) instead of embedding credentials here.',
    detail: 'Endpoint and key are resolved at run time, so rotating a key in Settings updates every agent that uses it.',
  },
  'provider.model': {
    summary: 'The model id this agent talks to, e.g. gpt-4o. Pick one from the list or type any model your provider serves.',
  },
  'provider.presets': {
    summary: 'One-click starting points that fill in the type, base URL and an ${ENV_VAR} key reference for popular providers.',
  },
  'provider.type': {
    summary: 'Which API family the custom endpoint speaks: openai (OpenAI-compatible), anthropic, or azure.',
  },
  'provider.baseUrl': {
    summary: 'Root URL of the custom endpoint, e.g. https://api.openai.com/v1. Only used in the advanced custom-endpoint mode.',
  },
  'provider.wireApi': {
    summary: 'Which request shape to use when calling the endpoint: completions (chat completions) or responses (the newer Responses API).',
    detail: 'Leave on default unless your endpoint needs one; most OpenAI-compatible servers work with the default.',
  },
  'provider.azureApiVersion': {
    summary: 'Azure OpenAI requires an api-version query parameter, e.g. 2024-10-21. Only used when the type is azure.',
  },
  'provider.providerApiKey': {
    summary: 'Credential for the custom endpoint: paste a key to have it sealed with AES-256-GCM on save, or reference an environment variable such as ${OPENAI_API_KEY} that is expanded at load time.',
    detail: 'A sealed key (enc:v1:…) is never stored as plaintext, and an ${ENV_VAR} reference keeps secrets out of the definition entirely.',
  },

  // ── Persona & task ──────────────────────────────────────────────────
  'persona.systemMessage.mode': {
    summary: "How the SDK's default Copilot system prompt is modified: append keeps it and adds your text, customize overrides individual sections, replace drops it entirely.",
    detail: 'The default prompt carries tool instructions and safety guardrails, so replace only if your text covers them.',
  },
  'persona.systemMessage.content': {
    summary: "Your instructions for the agent: its role, tone, what good output looks like, and anything it must never do. Markdown is supported.",
    detail: 'In append mode this text is added after the Copilot default prompt; in replace mode it becomes the whole system prompt.',
  },
  'persona.systemMessage.acknowledgeReplaceRisks': {
    summary: "Confirms you understand that replacing the system prompt drops Copilot's built-in tool instructions and safety guardrails.",
  },
  'persona.systemMessage.sections': {
    summary: 'Per-section overrides of the default prompt: keep a section unchanged (inherit), replace or remove it, or append/prepend your own text to just that section.',
  },
  'task.prompt': {
    summary: 'The default objective handed to the agent when it is started from Run without typing a task.',
    detail: 'Leave it empty for a pure chat agent; chat conversations never use this prompt.',
  },
  'task.deliveryMode': {
    summary: 'How a queued headless run is scheduled: enqueue waits for current work to finish, immediate starts as soon as a worker is free.',
  },

  // ── Tools ───────────────────────────────────────────────────────────
  'tools.builtins': {
    summary: 'Which built-in runtime tools (files, search, shell, session) are exposed to the agent, and the decision for each one.',
    detail: 'Availability shapes the tool list the model sees; per-tool allow/ask/deny decisions shape the permission hooks.',
  },
  'tools.available': {
    summary: 'Allowlist of tool names exposed to the agent. Leave empty for no restriction; when set, only these tools appear in the session.',
  },
  'tools.excluded': {
    summary: 'Tool names hidden from the agent even when they would otherwise be available, e.g. keep bash away from a read-only reviewer.',
  },
  'tools.harness': {
    summary: 'Injects the built-in coding-harness tools (bash, mkdir, write) and auto-creates parent directories for create/write/edit.',
    detail: 'Turn it off for a locked-down read-only agent.',
  },
  'tools.builtins.default': {
    summary: 'Default allow/ask/deny posture for any tool without an explicit decision, including MCP and custom tools.',
  },
  'tools.permissionPolicy': {
    summary: 'Fallback for tool calls no other rule decides: pattern-list checks the rules below first, deny-all blocks everything left over, approve-all-ci-only is a permissive CI posture.',
  },
  'tools.patterns': {
    summary: 'Ordered allow/deny rules matched on the tool name; they are checked before the fallback policy above.',
    detail: 'The optional reason is recorded in the audit trail whenever the rule fires.',
  },
  'tools.allowDestructive': {
    summary: 'Lifts the built-in gate that blocks wrecking commands (recursive deletes, force pushes, process kills) and update/delete-flagged MCP calls.',
    detail: 'Off by default; turn it on only for an agent you completely trust.',
  },
  'tools.custom': {
    summary: 'Extra tools declared here and invoked by name at run time; the tool handler wires the actual implementation.',
  },
  'tools.custom.name': {
    summary: 'The name the model uses when calling this tool, e.g. lookup_ticket. Letters, digits, underscore, colon and dash only.',
  },
  'tools.custom.description': {
    summary: 'Shown to the model; describe what the tool does and when to use it so the agent picks the right tool.',
  },
  'tools.custom.parametersSchema': {
    summary: 'JSON Schema for the arguments the model must send, e.g. {"type":"object","properties":{"id":{"type":"string"}}}.',
    detail: 'Required properties are enforced before the call reaches your handler.',
  },
  'tools.custom.skipPermission': {
    summary: 'Invokes the tool without an approval gate. Use only for tools that cannot modify files or state.',
  },

  // ── MCP ─────────────────────────────────────────────────────────────
  'mcp.use': {
    summary: "References to servers in the MCP registry; their tools are added to the agent's session at run time.",
    detail: 'Servers live in the registry, so one registration can be reused by many agents.',
  },
  'mcp.use.allow': {
    summary: 'Comma-separated tool names to keep from this server; everything else it offers is hidden from the agent.',
  },
  'mcp.use.deny': {
    summary: 'Comma-separated tool names to hide from this agent even though the server offers them.',
  },
  'mcp.server.name': {
    summary: 'Registry name for this server; agent definitions reference it under mcp.use.',
  },
  'mcp.server.transport': {
    summary: 'How the client talks to the server: stdio spawns a local command, http or sse connect to a URL.',
  },
  'mcp.server.description': {
    summary: 'Shown in the registry list so you and others can find the right server later.',
  },
  'mcp.server.command': {
    summary: 'Executable spawned for a stdio server, e.g. npx.',
  },
  'mcp.server.args': {
    summary: 'Command-line arguments for the stdio command, e.g. -y @modelcontextprotocol/server-filesystem .',
  },
  'mcp.server.env': {
    summary: 'KEY=value lines passed to the stdio process, one per line.',
  },
  'mcp.server.url': {
    summary: 'Endpoint for http/sse servers, e.g. https://example.com/mcp.',
  },

  // ── Knowledge & instructions ────────────────────────────────────────
  'knowledge.workingDirectory': {
    summary: "Folder the agent's sessions start in. Leave empty to use the active project, or a private scratch folder outside a project.",
  },
  'knowledge.additionalDirectories': {
    summary: 'Extra folders the agent may read and write besides the working directory.',
  },
  'knowledge.sessionStore': {
    summary: 'Lets the agent remember things across sessions through the long-term session store.',
  },
  'instructions.agentsMdPaths': {
    summary: "Instruction files (AGENTS.md, CLAUDE.md, copilot-instructions.md…) injected into the agent's context every session.",
  },
  'instructions.refreshDiscoveryCache': {
    summary: 'Re-scans the working folder for instruction files on every session instead of trusting the discovery cache.',
  },
  'instructions.global': {
    summary: 'Always-on rules added to every session, no matter which files are being worked on, e.g. Always write unit tests for new functions.',
  },
  'instructions.scoped': {
    summary: 'Rules that apply only to files matching a glob pattern, e.g. Use strict TypeScript under **/*.ts.',
    detail: 'The pattern goes in Applies to and the rule text below it.',
  },

  // ── Sub-agents ──────────────────────────────────────────────────────
  'agents.name': {
    summary: 'Identifier the main agent uses when delegating to this sub-agent.',
  },
  'agents.displayName': {
    summary: 'Human-readable name for the sub-agent, shown in run transcripts and the UI.',
  },
  'agents.model': {
    summary: "Optional model override for this sub-agent; leave empty to inherit the main agent's model.",
  },
  'agents.description': {
    summary: 'When the main agent should call this sub-agent — this text is what it reads when choosing.',
  },
  'agents.prompt': {
    summary: "The sub-agent's own system prompt: its role, rules and what a good result looks like.",
  },
  'agents.tools': {
    summary: 'Tools this sub-agent may use; leave empty to give it the full tool set.',
  },
  'agents.skills': {
    summary: 'Skills loaded for this sub-agent only.',
  },
  'agents.infer': {
    summary: 'When on, the main agent may pick this sub-agent on its own; when off, it is used only when explicitly assigned or set as default.',
  },
  'defaultAgent': {
    summary: 'Sub-agent that runs first instead of the main agent — useful for a single-purpose worker.',
  },

  // ── Skills ──────────────────────────────────────────────────────────
  'skills.directories': {
    summary: 'Folders scanned for SKILL.md files to load as skills.',
  },
  'skills.disabled': {
    summary: 'Skills to exclude even when discovered.',
  },

  // ── Fleet ───────────────────────────────────────────────────────────
  'fleet.enabled': {
    summary: 'Runs several sub-agents in parallel on one task and merges their work.',
  },
  'fleet.prompt': {
    summary: 'Orchestration instructions for fleet mode: how the task is split between workers and how results are merged.',
  },
  'fleet.maxConcurrentWorkers': {
    summary: 'How many sub-agents may run at once (1–50).',
  },

  // ── Runtime ─────────────────────────────────────────────────────────
  'runtime.turnTimeoutMs': {
    summary: 'Budget for a single agent turn, in milliseconds (1,000–21,600,000).',
    detail: 'Multi-file builds routinely need more than a few minutes; unset means the 45-minute default.',
  },
  'runtime.idleTimeoutSecs': {
    summary: 'How long the agent may sit idle before the run is stopped, in seconds.',
  },
  'runtime.maxAiCredits': {
    summary: 'Cap on AI credits the agent may spend; the run stops when the budget is gone.',
  },
  'runtime.logLevel': {
    summary: 'Verbosity of runtime logs for this agent: error, warning, info or debug.',
  },
  'runtime.streaming': {
    summary: 'Streams response tokens to the client as they are generated instead of waiting for the full answer.',
  },
  'runtime.autopilot': {
    summary: 'Experimental: lets the agent continue on its own until the task is complete instead of stopping after each step.',
  },
  'runtime.toolSearch.enabled': {
    summary: 'Controls the deferred tool-search tool: turn Preload tools on to load every tool into the session up front instead of discovering them on demand.',
  },

  // ── AI drafting helper ──────────────────────────────────────────────
  'assist.maxTokens': {
    summary: 'Token ceiling for the AI drafting call that writes or improves this text.',
  },
  'assist.timeoutMs': {
    summary: 'How long the AI drafting call may run before it is abandoned, in milliseconds.',
  },
  'assist.temperature': {
    summary: 'Creativity of the AI drafting call: lower is literal, higher is more varied.',
  },
  'assist.apiKey': {
    summary: 'Optional key (or ${ENV_VAR}) used only for drafting when the selected provider key cannot be resolved. It is never saved.',
  },

  // ── Import dialog ───────────────────────────────────────────────────
  'import.agentProfile': {
    summary: 'Paste a GitHub Copilot custom agent profile (.agent.md) to import it as a definition here.',
  },
  'import.definitionJson': {
    summary: 'Paste a raw agent definition JSON (schemaVersion 1.0) to load it into the builder.',
  },
};

/** Tooltip body for a field key: summary first, then an optional muted detail line. Unknown keys render nothing. */
export function info(key: string): ReactNode {
  const entry = FIELD_INFO[key];
  if (!entry) return null;
  return createElement(
    Fragment,
    null,
    entry.summary,
    entry.detail ? createElement('span', { className: 'mt-1 block text-[11px] text-muted' }, entry.detail) : null,
  );
}
