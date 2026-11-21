import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { ArtifactRow } from '../../systems/types.js';
import type { TeamStore } from '../../store/teams.js';

/** Reduce a model-supplied name to a single safe path segment. */
export function safeArtifactName(name: string): string {
  const base = String(name ?? '').trim().replace(/\\/g, '/').split('/').pop() ?? '';
  const clean = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return (clean || 'artifact.txt').slice(0, 120);
}

export function sha256(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

export interface ArtifactSink {
  store: TeamStore;
  systemRunId: string;
  memberId: string;
  /** Shared, run-scoped artifact directory (all members can read it). */
  artifactsDir: string;
  nodeId?: string | null;
  taskId?: string | null;
  emit?: (kind: string, payload: Record<string, unknown>) => void;
}

/**
 * Persist one deliverable: write the bytes, hash them, register the versioned row.
 * Re-publishing the same (member, name) increments the version rather than
 * overwriting history — reviews can point at exactly the version they saw.
 */
export function publishArtifact(sink: ArtifactSink, input: { type: string; name: string; content?: string; memberWorkspace?: string }): ArtifactRow {
  const name = safeArtifactName(input.name);
  const memberDir = sink.memberId.replace(/[^A-Za-z0-9._-]+/g, '-');
  const dir = resolve(sink.artifactsDir, memberDir);
  mkdirSync(dir, { recursive: true });
  const target = resolve(dir, name);
  if (relative(dir, target).startsWith('..') || target.split(sep).includes('..')) throw new Error(`unsafe artifact name: ${input.name}`);

  let content = typeof input.content === 'string' ? input.content : undefined;
  if (content === undefined && input.memberWorkspace) {
    const candidate = resolve(input.memberWorkspace, name);
    if (relative(resolve(input.memberWorkspace), candidate).startsWith('..') === false && existsSync(candidate)) {
      content = readFileSync(candidate, 'utf8');
    }
  }
  const body = content ?? '';
  if (!body.trim()) throw new Error(`artifact '${name}' has no content — nothing was published`);
  const contentHash = sha256(body);
  // Members often publish the same deliverable twice (once through the response
  // contract, once through team_publish_artifact). Identical bytes are one version,
  // so a repeated publish cannot bury the version a reviewer actually read.
  const prior = sink.store.listArtifacts(sink.systemRunId)
    .filter((a) => a.member_id === sink.memberId && a.name === name && a.content_hash === contentHash)
    .sort((a, b) => b.version - a.version)[0];
  if (prior) return prior;
  writeFileSync(target, body, 'utf8');
  const row = sink.store.addArtifact({
    systemRunId: sink.systemRunId,
    memberId: sink.memberId,
    type: String(input.type ?? 'document').trim() || 'document',
    name,
    contentHash,
    path: target,
    bytes: Buffer.byteLength(body, 'utf8'),
    nodeId: sink.nodeId ?? null,
    taskId: sink.taskId ?? null,
  });
  sink.emit?.('artifact.publish', { artifactId: row.id, name: row.name, type: row.type, version: row.version, bytes: row.bytes, memberId: sink.memberId });
  return row;
}

export function artifactSummary(rows: ArtifactRow[]): { id: string; type: string; name: string; version: number; memberId: string; path: string | null }[] {
  return rows.map((r) => ({ id: r.id, type: r.type, name: r.name, version: r.version, memberId: r.member_id, path: r.path }));
}

export function artifactsDirFor(runWorkspace: string): string {
  return join(resolve(runWorkspace), 'artifacts');
}

export function memberWorkspaceFor(runWorkspace: string, memberId: string): string {
  const safe = memberId.replace(/[^A-Za-z0-9._-]+/g, '-');
  return join(resolve(runWorkspace), 'members', safe);
}
