/**
 * Agent2Agent (A2A) wire types.
 *
 * The platform speaks the JSON-RPC 2.0 binding of the published A2A spec. We keep
 * the v0.3 method names (`message/send`, `message/stream`, `tasks/get`,
 * `tasks/cancel`) because they are the widest-supported client surface, and accept
 * the v1.0 aliases (`SendMessage`, `SendStreamingMessage`, `GetTask`, `CancelTask`)
 * on the same endpoint.
 */

export type A2ARole = 'user' | 'agent';

export interface A2ATextPart {
  kind: 'text';
  text: string;
  metadata?: Record<string, unknown>;
}

export interface A2ADataPart {
  kind: 'data';
  data: unknown;
  metadata?: Record<string, unknown>;
}

export interface A2AFilePart {
  kind: 'file';
  file: { name?: string; mimeType?: string; bytes?: string; uri?: string };
  metadata?: Record<string, unknown>;
}

export type A2APart = A2ATextPart | A2ADataPart | A2AFilePart;

export interface A2AMessage {
  kind: 'message';
  messageId: string;
  role: A2ARole;
  parts: A2APart[];
  contextId?: string;
  taskId?: string;
  referenceTaskIds?: string[];
  metadata?: Record<string, unknown>;
}

export type A2ATaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'canceled'
  | 'failed'
  | 'rejected'
  | 'auth-required'
  | 'unknown';

export interface A2ATaskStatus {
  state: A2ATaskState;
  message?: A2AMessage;
  timestamp?: string;
}

export interface A2AArtifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: A2APart[];
  metadata?: Record<string, unknown>;
}

export interface A2ATask {
  kind: 'task';
  id: string;
  contextId: string;
  status: A2ATaskStatus;
  artifacts?: A2AArtifact[];
  history?: A2AMessage[];
  metadata?: Record<string, unknown>;
}

export interface A2AStatusUpdateEvent {
  kind: 'status-update';
  taskId: string;
  contextId: string;
  status: A2ATaskStatus;
  final: boolean;
  metadata?: Record<string, unknown>;
}

export interface A2AArtifactUpdateEvent {
  kind: 'artifact-update';
  taskId: string;
  contextId: string;
  artifact: A2AArtifact;
  append?: boolean;
  lastChunk?: boolean;
  metadata?: Record<string, unknown>;
}

export interface A2ASkill {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

export interface A2AAgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  protocolVersion: string;
  preferredTransport?: string;
  capabilities: { streaming?: boolean; pushNotifications?: boolean; stateTransitionHistory?: boolean };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: A2ASkill[];
  securitySchemes?: Record<string, unknown>;
  security?: Record<string, string[]>[];
  /** Forward-compatible v1.0 discovery hint. */
  supportedInterfaces?: { url: string; protocolBinding: string; protocolVersion?: string }[];
  metadata?: Record<string, unknown>;
}

export interface A2AJsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface A2AJsonRpcSuccess<T = unknown> {
  jsonrpc: '2.0';
  id: string | number | null;
  result: T;
}

export interface A2AJsonRpcError {
  jsonrpc: '2.0';
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

export const A2A_PROTOCOL_VERSION = '0.3.0';

export const A2A_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  taskNotFound: -32001,
  taskNotCancelable: -32002,
  unsupportedOperation: -32004,
} as const;
