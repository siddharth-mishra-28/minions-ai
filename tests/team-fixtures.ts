import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SqliteAdapter } from '../src/store/sqlite.js';

/** Minimal valid agent definition — enough for the loader/schema, never executed. */
export function agentDefinition(name: string, version = '1.0.0'): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    metadata: { name, version, description: `${name} fixture` },
    agents: [{ name: 'worker', displayName: name, description: 'w', prompt: 'p', tools: [], infer: false }],
    defaultAgent: 'worker',
    task: { prompt: 'do the work' },
    knowledge: { workingDirectory: '', sessionStore: false },
    tools: { builtins: { all: true, default: 'allow', perTool: {} }, allowDestructive: false },
    provider: { type: 'openai', baseUrl: 'https://unit-test.invalid/v1', model: 'stub', wireApi: 'completions', providerApiKey: 'stub' },
  };
}

export function hashOf(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)}`;
}

/** Register a fixture agent and return its pinned ref for team membership. */
export function registerAgent(db: SqliteAdapter, name: string, version = '1.0.0', hash?: string): { agentId: string; version: string; definitionHash: string } {
  const def = agentDefinition(name, version);
  const definitionHash = hash ?? hashOf(def);
  db.saveAgent(name, version, JSON.stringify(def), definitionHash);
  return { agentId: `${name}@${version}`, version, definitionHash };
}

export function tempWorkspace(prefix = 'team-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

interface MemberSpec {
  memberId: string;
  role: string;
  agentId: string;
  version: string;
  definitionHash: string;
  reportsTo?: string;
  instructions?: string;
  delegation?: Record<string, unknown>;
}

export function member(spec: MemberSpec): Record<string, unknown> {
  return {
    memberId: spec.memberId,
    role: spec.role,
    ...(spec.reportsTo ? { reportsTo: spec.reportsTo } : {}),
    ...(spec.instructions ? { instructions: spec.instructions } : {}),
    ...(spec.delegation ? { delegation: spec.delegation } : {}),
    agentRef: { agentId: spec.agentId, version: spec.version, definitionHash: spec.definitionHash },
  };
}

export function sequentialTeam(members: MemberSpec[], opts: { allowPeerToPeer?: boolean } = {}): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    kind: 'agent-system',
    metadata: { id: 'delivery-team', name: 'Delivery Team', version: '1.0.0', description: 'Sequential delivery fixture' },
    team: { members: members.map(member) },
    orchestration: {
      defaultWorkflowId: 'delivery',
      communication: { enabled: true, allowPeerToPeer: opts.allowPeerToPeer ?? true, maxRounds: 3 },
      workflows: [
        {
          workflowId: 'delivery',
          name: 'Sequential delivery',
          mode: 'sequential',
          version: '1.0.0',
          entryNodeId: 'analysis',
          limits: { maxNodeRuns: 8, maxIterations: 4, maxAttempts: 1 },
          nodes: [
            { nodeId: 'analysis', type: 'agent-task', memberId: 'analyst', outputContract: { artifactTypes: ['requirements-document'], required: true } },
            { nodeId: 'build', type: 'agent-task', memberId: 'developer' },
            { nodeId: 'review', type: 'agent-task', memberId: 'qa' },
            { nodeId: 'done', type: 'terminal' },
          ],
          edges: [
            { from: 'analysis', to: 'build' },
            { from: 'build', to: 'review' },
            { from: 'review', to: 'done', when: { path: 'output.status', operator: 'in', value: ['passed', 'done'] } },
            { from: 'review', to: 'build', when: { path: 'output.status', operator: 'in', value: ['failed', 'blocked'] } },
          ],
        },
      ],
    },
  };
}

export function managerTeam(members: MemberSpec[], opts: { allowDynamic?: boolean; allowPeerToPeer?: boolean } = {}): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    kind: 'agent-system',
    metadata: { id: 'agile-team', name: 'Agile Team', version: '1.0.0', description: 'Manager-led fixture' },
    team: { members: members.map(member) },
    orchestration: {
      defaultWorkflowId: 'agile',
      communication: { enabled: true, allowPeerToPeer: opts.allowPeerToPeer ?? true, maxRounds: 3 },
      workflows: [
        {
          workflowId: 'agile',
          name: 'Manager led delivery',
          mode: 'hierarchical',
          version: '1.0.0',
          entryNodeId: 'manager',
          limits: { maxNodeRuns: 12, maxIterations: 4, maxAttempts: 1 },
          manager: { memberId: 'manager', maxDelegationDepth: 2, maxParallelTasks: 2, allowDynamicTaskCreation: opts.allowDynamic ?? false, requireCompletionReview: true },
          nodes: [
            { nodeId: 'manager', type: 'manager', memberId: 'manager' },
            { nodeId: 'done', type: 'terminal' },
          ],
          edges: [{ from: 'manager', to: 'done', when: { path: 'output.status', operator: 'equals', value: 'complete' } }],
        },
      ],
    },
  };
}

export function approvalTeam(members: MemberSpec[]): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    kind: 'agent-system',
    metadata: { id: 'approval-team', name: 'Approval Team', version: '1.0.0', description: 'Human gate fixture' },
    team: { members: members.map(member) },
    orchestration: {
      defaultWorkflowId: 'gated',
      workflows: [
        {
          workflowId: 'gated',
          name: 'Gated delivery',
          mode: 'sequential',
          version: '1.0.0',
          entryNodeId: 'start',
          limits: { maxNodeRuns: 6, maxIterations: 3, maxAttempts: 1 },
          nodes: [
            { nodeId: 'start', type: 'agent-task', memberId: 'analyst' },
            { nodeId: 'signoff', type: 'human-approval', memberId: 'product-owner', approval: { prompt: 'Ship it?' } },
            { nodeId: 'done', type: 'terminal' },
          ],
          edges: [
            { from: 'start', to: 'signoff' },
            { from: 'signoff', to: 'done', when: { path: 'output.status', operator: 'equals', value: 'approved' } },
            { from: 'signoff', to: 'start', when: { path: 'output.status', operator: 'equals', value: 'changes-requested' } },
          ],
        },
      ],
    },
  };
}

export function jsonBlock(value: Record<string, unknown>): string {
  return `Working on it.\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}
