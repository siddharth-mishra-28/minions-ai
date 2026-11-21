import { CopilotClient } from '@github/copilot-sdk';
import { toSessionOptions, resolveApiKey, modelListing } from '../../agents/translator.js';
import { compilePermissionHandlers } from '../../agents/permissions.js';
import { buildHarnessTools, autoMkdirPreTool, harnessEnabled, resolveTurnTimeoutMs } from '../../agents/harness-tools.js';
import { buildMemoryTools } from '../../memory/tools.js';
import { expandMcpRefs, type McpServerConfig } from '../../mcp/mcp.js';
import { AuditLog, newTraceId } from '../../core/audit.js';
import { ensureCopilotRuntime } from '../../core/copilot-runtime.js';
import { redactedForLog } from '../../agents/loader.js';
import { resolveProviderRef } from '../../agents/default-agent.js';
import { createUsageProxy, type UsageProxy } from '../usage-proxy.js';
import { PlatformStore } from '../../store/platform.js';
import type { SqliteAdapter } from '../../store/sqlite.js';
import type { DbAdapter } from '../../store/adapter.js';
import type { AgentDefinition } from '../../core/types.js';
import type { MemoryRuntime } from '../../memory/runtime.js';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface TeamTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
  skipPermission?: boolean;
  defer?: 'never' | 'auto';
}

export interface MemberTurnRequest {
  /** Team run + workflow node this turn belongs to. */
  teamRunId: string;
  nodeId: string;
  memberId: string;
  role: string;
  agentId: string;
  definitionHash: string;
  /** Portable definition snapshot (env refs intact) recorded on the node's run row. */
  definitionSnapshot: string;
  /** Run-ready definition (env expanded, provider ref resolved by the executor). */
  definition: AgentDefinition;
  sessionId: string;
  prompt: string;
  /** This member's own workspace for the run. */
  workspaceRoot: string;
  approvalMode: 'autopilot' | 'strict' | 'interactive';
  timeoutMs?: number;
  tools?: TeamTool[];
  mcpRegistry?: Map<string, McpServerConfig>;
  mcpRegistryTools?: Map<string, string[]>;
  signal?: AbortSignal;
  onEvent?: (type: string, payload: Record<string, unknown>) => void;
  memory?: MemoryRuntime;
  /** Optional human approval hook (interactive mode). */
  requestApproval?: (info: { tool: string; args: unknown; source: string }) => Promise<{ allow: boolean; reason?: string }>;
}

export interface MemberTurnResult {
  runId: string;
  sessionId: string;
  traceId: string;
  text: string;
  tools: { name: string; success?: boolean }[];
  tokensIn?: number;
  tokensOut?: number;
}

/** The single seam that keeps the engine testable without a live model. */
export interface MemberExecutor {
  run(req: MemberTurnRequest): Promise<MemberTurnResult>;
}

export interface CopilotExecutorContext {
  db: DbAdapter;
  /** Directory that holds per-run audit folders (kept outside member workspaces). */
  auditRoot: string;
  /** Optional memory runtime builder for a member turn. */
  memoryFor?: (req: { definition: AgentDefinition; memberId: string; agentId: string; task: string; runId: string }) => MemoryRuntime | undefined;
}

/**
 * Executes one team-member turn on the Copilot SDK.
 *
 * One session per member for the whole team run: the caller passes a stable
 * `sessionId`, and every turn resumes it, so a member keeps its own conversation
 * history, provider, tools, MCP servers and memory — exactly the definition that
 * was pinned in the team snapshot. Nothing here can reach another member's session.
 */
export function createCopilotExecutor(ctx: CopilotExecutorContext): MemberExecutor {
  return {
    async run(req: MemberTurnRequest): Promise<MemberTurnResult> {
      const def = req.definition.provider?.providerRef
        ? resolveProviderRef(req.definition, new PlatformStore(ctx.db as SqliteAdapter))
        : req.definition;
      const apiKey = resolveApiKey(def);
      const traceId = newTraceId();
      const workspace = resolve(req.workspaceRoot);
      mkdirSync(workspace, { recursive: true });
      const runId = ctx.db.createRun(req.agentId, req.sessionId, traceId, def.provider.model, def.provider.type, req.prompt, req.definitionHash, {
        source: 'team',
        definitionJson: req.definitionSnapshot,
      });
      const auditDir = join(resolve(ctx.auditRoot, req.teamRunId), `${req.memberId}_${runId}`);
      mkdirSync(auditDir, { recursive: true });
      try { ctx.db.setRunAuditPath(runId, auditDir); } catch { /* best-effort */ }
      const audit = new AuditLog(auditDir);
      const startedAt = Date.now();
      const emit = (type: string, payload: Record<string, unknown>): void => {
        const ev = audit.append(type, payload);
        try { ctx.db.appendEvent(runId, ev.seq, type, JSON.stringify(ev.payload), true); } catch { /* best-effort */ }
        try { req.onEvent?.(type, ev.payload); } catch { /* best-effort */ }
      };
      const memory = req.memory ?? ctx.memoryFor?.({ definition: def, memberId: req.memberId, agentId: req.agentId, task: req.prompt, runId });
      memory?.setRunId(runId);

      // Wire-level token capture: the Copilot runtime masks per-call usage for BYOK
      // providers, so a one-shot local proxy fronts the real completions endpoint and
      // reports exact tokens for this member turn (same mechanism as headless runs).
      let usageProxy: UsageProxy | undefined;
      const usageTotals = { calls: 0, tokIn: 0, tokOut: 0 };
      const recordUsageTotals = (elapsedMs: number): void => {
        if (!usageProxy || usageTotals.calls === 0) return;
        try { ctx.db.recordUsage(runId, { tokensIn: usageTotals.tokIn, tokensOut: usageTotals.tokOut, durationMs: elapsedMs, endpoint: 'usage-proxy' }); } catch { /* best-effort */ }
      };

      ensureCopilotRuntime();
      const client = new CopilotClient({ onListModels: () => [modelListing(def) as never] });
      await client.start();
      // Started after the client so a failed start cannot leak the proxy's listener.
      if (def.provider.type === 'openai' && (def.provider.wireApi ?? 'completions') === 'completions' && def.provider.baseUrl) {
        try {
          usageProxy = await createUsageProxy({
            upstream: def.provider.baseUrl,
            onUsage: (capture) => {
              usageTotals.calls += 1;
              usageTotals.tokIn += capture.tokIn ?? 0;
              usageTotals.tokOut += capture.tokOut ?? 0;
              emit('usage.capture', { runs: 1, ...capture });
            },
          });
          emit('usage.proxy', { proxyUrl: usageProxy.url, upstream: new URL(def.provider.baseUrl).host });
        } catch (e) {
          emit('usage.proxy', { error: `usage capture unavailable: ${(e as Error).message}` });
        }
      }
      let session: Awaited<ReturnType<CopilotClient['createSession']>> | undefined;
      let aborted = false;
      const onAbort = (): void => {
        aborted = true;
        void (session as { abort?: () => Promise<void> } | undefined)?.abort?.().catch(() => { /* finished */ });
      };
      req.signal?.addEventListener('abort', onAbort, { once: true });
      const tools: { name: string; success?: boolean }[] = [];
      let outcome: 'done' | 'failed' | 'aborted' = 'failed';
      try {
        if (req.signal?.aborted) throw new Error('team run stopped');

        let memoryContext: string | undefined;
        if (memory) {
          memory.setEventSink((type, payload) => emit(type, payload));
          try {
            const recalled = await memory.recall(req.prompt.slice(0, 4000));
            memoryContext = recalled.block;
          } catch (e) {
            emit('memory.error', { error: (e as Error).message });
          }
        }

        const sessionOpts = toSessionOptions(def, apiKey, { memoryContext });
        if (usageProxy) {
          const provider = (sessionOpts as { provider?: Record<string, unknown> }).provider;
          if (provider && 'baseUrl' in provider) provider.baseUrl = usageProxy.url;
        }
        (sessionOpts as Record<string, unknown>).workingDirectory = workspace;
        const harnessTools = harnessEnabled(def)
          ? buildHarnessTools({ workspaceRoot: workspace, onToolEvent: (type, payload) => emit(type, payload) })
          : [];
        const memoryTools = memory
          ? buildMemoryTools({ store: memory.store, config: memory.config, dataset: memory.agentDataset, runId, onEvent: (type, payload) => emit(type, payload) })
          : [];
        const injected: unknown[] = [...(req.tools ?? []), ...harnessTools, ...memoryTools];
        if (injected.length) {
          const existing = (sessionOpts as { tools?: { name?: string }[] }).tools ?? [];
          const names = new Set(injected.map((t) => (t as { name?: string }).name ?? ''));
          (sessionOpts as Record<string, unknown>).tools = [...injected, ...existing.filter((t) => !names.has(t.name ?? ''))];
        }
        if (def.mcp?.use?.length && req.mcpRegistry) {
          const { servers, disabled } = expandMcpRefs(def.mcp.servers, def.mcp.use, req.mcpRegistry, req.mcpRegistryTools ?? new Map());
          (sessionOpts as Record<string, unknown>).mcpServers = { ...((sessionOpts.mcpServers as Record<string, unknown>) ?? {}), ...servers };
          (sessionOpts as Record<string, unknown>).disabledMcpServers = [...((sessionOpts.disabledMcpServers as string[]) ?? []), ...disabled];
        }
        (sessionOpts as Record<string, unknown>).sessionId = req.sessionId;

        const { onPermissionRequest, onPreToolUse } = compilePermissionHandlers(
          def,
          { ciApproveAll: req.approvalMode === 'autopilot', harnessTools: harnessEnabled(def), approvalMode: req.approvalMode },
          {
            onAskResolved: (info) => emit('permission.ask_resolved', info),
            onAskDeferred: (info) => emit('permission.ask_denied', { ...info, reason: "headless team turn: 'ask' denied" }),
            onDestructiveDeny: (info) => emit('permission.destructive_denied', info),
            requestApproval: req.requestApproval,
          },
        );
        (sessionOpts as Record<string, unknown>).onPermissionRequest = onPermissionRequest;
        const autoMkdir = autoMkdirPreTool(workspace);
        (sessionOpts as Record<string, unknown>).hooks = {
          onPreToolUse: async (input: { toolName?: string; tool?: string; toolArgs?: unknown }) => {
            const decision = (await onPreToolUse(input)) as { permissionDecision?: string; additionalContext?: string } | undefined;
            if (decision?.permissionDecision === 'deny') return decision;
            const mkdirResult = harnessEnabled(def) ? (await autoMkdir(input)) as { permissionDecision?: string; additionalContext?: string } | undefined : undefined;
            if (mkdirResult?.permissionDecision === 'deny') return mkdirResult;
            if (mkdirResult?.additionalContext) {
              return { ...decision, additionalContext: decision?.additionalContext ? `${decision.additionalContext}\n${mkdirResult.additionalContext}` : mkdirResult.additionalContext };
            }
            return decision;
          },
        };

        try {
          session = await client.resumeSession(req.sessionId, sessionOpts);
          emit('session.resume', { sessionId: req.sessionId });
        } catch {
          session = await client.createSession(sessionOpts as never);
          emit('session.create', { sessionId: req.sessionId });
        }
        try { ctx.db.upsertSession({ sessionId: req.sessionId, runId, agentId: req.agentId, traceId, status: 'created' }); } catch { /* best-effort */ }

        emit('run.start', { teamRunId: req.teamRunId, nodeId: req.nodeId, memberId: req.memberId, agentId: req.agentId, definition: redactedForLog(def) });
        let tokensIn: number | undefined;
        let tokensOut: number | undefined;
        session.on('assistant.usage', (e: unknown) => {
          const u = e as { inputTokens?: number; outputTokens?: number; cost?: number; endpoint?: string; requestId?: string };
          // With the wire proxy active, exact accounting comes from usage.capture
          // events; the runtime only offers masked values here.
          if (usageProxy) return;
          tokensIn = (tokensIn ?? 0) + (u.inputTokens ?? 0);
          tokensOut = (tokensOut ?? 0) + (u.outputTokens ?? 0);
          try { ctx.db.recordUsage(runId, { tokensIn: u.inputTokens, tokensOut: u.outputTokens, credits: u.cost, endpoint: u.endpoint, requestId: u.requestId }); } catch { /* no-op */ }
        });
        session.on('tool.execution_start', (e: unknown) => {
          const d = (e as { data?: { toolName?: string } }).data;
          if (d?.toolName) { tools.push({ name: d.toolName }); emit('tool.call', { tool: d.toolName }); }
        });
        session.on('tool.execution_complete', (e: unknown) => {
          const d = (e as { data?: { toolName?: string; success?: boolean } }).data;
          if (d?.toolName) {
            const entry = tools.find((t) => t.name === d.toolName && t.success === undefined);
            if (entry) entry.success = d.success;
            emit('tool.result', { tool: d.toolName, success: d.success });
          }
        });
        session.on('session.error', (e: unknown) => {
          const d = (e as { data?: { message?: string; error?: string } }).data;
          emit('session.error', { message: d?.message ?? d?.error });
        });

        emit('prompt.send', { chars: req.prompt.length, memberId: req.memberId });
        const timeout = req.timeoutMs ?? resolveTurnTimeoutMs(def, undefined);
        const response = await (session as { sendAndWait: (a: unknown, t?: number) => Promise<unknown> }).sendAndWait({ prompt: req.prompt, mode: 'enqueue' }, timeout);
        const text = (response as { data?: { content?: string }; content?: string; text?: string })?.data?.content
          ?? (response as { content?: string })?.content
          ?? (response as { text?: string })?.text
          ?? '';
        if (aborted) throw new Error('team run stopped');
        outcome = 'done';
        emit('run.complete', { chars: text.length });
        ctx.db.finishRun(runId, 'done');
        try { ctx.db.upsertSession({ sessionId: req.sessionId, status: 'idle', summary: text.slice(0, 200) }); } catch { /* best-effort */ }
        try { await (session as { disconnect?: () => Promise<void> }).disconnect?.(); } catch { /* noop */ }
        await client.stop();
        recordUsageTotals(Date.now() - startedAt);
        return {
          runId, sessionId: req.sessionId, traceId, text, tools,
          tokensIn: usageProxy && usageTotals.calls ? usageTotals.tokIn : tokensIn,
          tokensOut: usageProxy && usageTotals.calls ? usageTotals.tokOut : tokensOut,
        };
      } catch (err) {
        const message = aborted ? 'team run stopped' : (err as Error).message;
        outcome = aborted ? 'aborted' : 'failed';
        emit(aborted ? 'run.aborted' : 'run.error', { error: message });
        ctx.db.finishRun(runId, aborted ? 'aborted' : 'failed', message);
        try { await (session as { disconnect?: () => Promise<void> } | undefined)?.disconnect?.(); } catch { /* noop */ }
        try { await client.stop(); } catch { /* noop */ }
        recordUsageTotals(Date.now() - startedAt);
        throw err;
      } finally {
        req.signal?.removeEventListener('abort', onAbort);
        await usageProxy?.close();
        try { await memory?.finish(outcome); } catch { /* best-effort */ }
      }
    },
  };
}

/**
 * Scripted executor for tests and for CI smoke runs that must not spend model
 * credits. Each call consumes one scripted response in order; the script can be a
 * function of the request so a test can react to the prompt (e.g. QA failing once).
 */
export function createScriptedExecutor(
  script: (req: MemberTurnRequest, call: number) => { text: string; fail?: string } | Promise<{ text: string; fail?: string }>,
): MemberExecutor {
  let call = 0;
  return {
    async run(req) {
      call += 1;
      const step = await script(req, call);
      if (step.fail) throw new Error(step.fail);
      return {
        runId: `scripted_${call}`,
        sessionId: req.sessionId,
        traceId: `tr_scripted_${call}`,
        text: step.text,
        tools: [],
        tokensIn: 10,
        tokensOut: 20,
      };
    },
  };
}
