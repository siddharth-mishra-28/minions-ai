import type { AgentSystemRow, TeamMember, WorkflowDefinition } from '../systems/types.js';
import { A2A_PROTOCOL_VERSION, type A2AAgentCard, type A2ASkill } from './types.js';

const cleanBase = (base: string): string => base.replace(/\/+$/, '');

function security(): Pick<A2AAgentCard, 'securitySchemes' | 'security'> {
  if (!process.env.A2A_TOKEN?.trim()) return {};
  return {
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'opaque' } },
    security: [{ bearer: [] }],
  };
}

function parse<T>(json: string): T | undefined {
  try { return JSON.parse(json) as T; } catch { return undefined; }
}

function workflowSkills(system: AgentSystemRow): A2ASkill[] {
  const def = parse<{ orchestration?: { workflows?: WorkflowDefinition[] } }>(system.definition_json);
  return (def?.orchestration?.workflows ?? []).map((w) => ({
    id: `${system.id}-${w.workflowId}`,
    name: w.name,
    description: `${w.mode} workflow "${w.workflowId}" with ${w.nodes.length} node(s) and ${w.edges.length} transition(s).`,
    tags: ['team', 'workflow', w.mode],
    examples: w.nodes.filter((n) => n.task).slice(0, 3).map((n) => String(n.task).slice(0, 180)),
  }));
}

export function platformCard(baseUrl: string, systems: AgentSystemRow[]): A2AAgentCard {
  const base = cleanBase(baseUrl);
  return {
    name: 'Minions-ai',
    description: 'Local agent-team orchestrator. Each published team is an A2A agent; members are exposed under the team.',
    url: `${base}/a2a`,
    version: '1.0.0',
    protocolVersion: A2A_PROTOCOL_VERSION,
    preferredTransport: 'JSONRPC',
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: systems.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description ?? `Agent team ${s.id}`,
      tags: ['team', ...(s.status === 'published' ? ['published'] : ['draft'])],
      examples: [`Run ${s.name} on an objective`],
    })),
    supportedInterfaces: [{ url: `${base}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: A2A_PROTOCOL_VERSION }],
    ...security(),
    metadata: { teams: systems.map((s) => ({ id: s.id, status: s.status, version: s.current_version })) },
  };
}

interface SystemDefinitionShape {
  metadata: { id: string; name: string; version: string; description?: string; tags?: string[] };
  team: { members: TeamMember[] };
  orchestration: { defaultWorkflowId: string; workflows: WorkflowDefinition[] };
}

export function teamCard(baseUrl: string, system: AgentSystemRow): A2AAgentCard {
  const base = cleanBase(baseUrl);
  const def = parse<SystemDefinitionShape>(system.definition_json);
  const members = def?.team.members ?? [];
  const workflows = def?.orchestration.workflows ?? [];
  const skills = workflowSkills(system);
  if (members.length) {
    skills.push({
      id: `${system.id}-specialists`,
      name: 'Specialist agents',
      description: members.map((m) => `${m.role} (${m.memberId})`).join(', '),
      tags: ['team', 'members'],
    });
  }
  return {
    name: system.name,
    description: system.description ?? def?.metadata.description ?? `Agent team ${system.id}`,
    url: `${base}/a2a/${encodeURIComponent(system.id)}`,
    version: system.current_version ?? def?.metadata.version ?? 'draft',
    protocolVersion: A2A_PROTOCOL_VERSION,
    preferredTransport: 'JSONRPC',
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills,
    supportedInterfaces: [{ url: `${base}/a2a/${encodeURIComponent(system.id)}`, protocolBinding: 'JSONRPC', protocolVersion: A2A_PROTOCOL_VERSION }],
    ...security(),
    metadata: {
      teamId: system.id,
      status: system.status,
      publishedVersion: system.current_version,
      defaultWorkflowId: def?.orchestration.defaultWorkflowId,
      workflows: workflows.map((w) => ({ id: w.workflowId, name: w.name, mode: w.mode })),
      members: members.map((m) => ({
        memberId: m.memberId, role: m.role, reportsTo: m.reportsTo ?? null,
        capabilities: m.capabilities ?? {}, agentRef: m.agentRef,
        cardUrl: `${base}/a2a/${encodeURIComponent(system.id)}/members/${encodeURIComponent(m.memberId)}/.well-known/agent-card.json`,
      })),
    },
  };
}

export function memberCard(baseUrl: string, system: AgentSystemRow, memberId: string): A2AAgentCard | undefined {
  const base = cleanBase(baseUrl);
  const def = parse<SystemDefinitionShape>(system.definition_json);
  const member = def?.team.members.find((m) => m.memberId === memberId);
  if (!member) return undefined;
  const reports = member.reportsTo
    ? `Reports to ${member.reportsTo}.`
    : 'Independent specialist in this team.';
  return {
    name: `${member.role} · ${system.name}`,
    description: `${member.role} in team ${system.name}. ${reports}`,
    url: `${base}/a2a/${encodeURIComponent(system.id)}/members/${encodeURIComponent(member.memberId)}`,
    version: system.current_version ?? 'draft',
    protocolVersion: A2A_PROTOCOL_VERSION,
    preferredTransport: 'JSONRPC',
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [{
      id: `${system.id}-${member.memberId}`,
      name: member.role,
      description: member.instructions?.slice(0, 600) ?? `${member.role} for ${system.name}`,
      tags: ['member', member.role.toLowerCase().replace(/[^a-z0-9]+/g, '-')],
      examples: member.instructions ? [member.instructions.slice(0, 180)] : undefined,
    }],
    supportedInterfaces: [{
      url: `${base}/a2a/${encodeURIComponent(system.id)}/members/${encodeURIComponent(member.memberId)}`,
      protocolBinding: 'JSONRPC', protocolVersion: A2A_PROTOCOL_VERSION,
    }],
    ...security(),
    metadata: {
      teamId: system.id, memberId, role: member.role, reportsTo: member.reportsTo ?? null,
      capabilities: member.capabilities ?? {}, agentRef: member.agentRef,
    },
  };
}
