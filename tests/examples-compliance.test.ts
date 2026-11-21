import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAgentDefinition } from '../src/agents/loader.js';
import { validateSystemDefinition } from '../src/systems/schema.js';
import { validateTeam } from '../src/systems/validate.js';

/**
 * The examples/ directory is the user-facing sample set: every definition there must
 * be compliant with the bundled schema in src/schema/ (the compliance contract for
 * ALL agent definitions) so the samples run out of the box.
 *
 * The shipped set is deliberately minimal — one base agent and one sample agent team —
 * because both are registered and published by `minions-assembler init`.
 */
const EXAMPLES_DIR = fileURLToPath(new URL('../examples/', import.meta.url));

const exampleFiles = readdirSync(EXAMPLES_DIR).filter((f) => f.endsWith('.json'));
const agentFiles = exampleFiles.filter((f) => !f.endsWith('.agent-system.json'));
const systemFiles = exampleFiles.filter((f) => f.endsWith('.agent-system.json'));
// Extra specialist agents may live in a nested folder (examples/agents/*.agent.json).
const nestedAgentFiles = readdirSync(EXAMPLES_DIR)
  .filter((entry) => {
    try { return statSync(join(EXAMPLES_DIR, entry)).isDirectory(); } catch { return false; }
  })
  .flatMap((dir) => readdirSync(join(EXAMPLES_DIR, dir))
    .filter((f) => f.endsWith('.agent.json'))
    .map((f) => join(dir, f)));

describe('examples/ schema compliance', () => {
  it('ships exactly five role agents and one sample agent system', () => {
    expect(agentFiles).toEqual(['architect.agent.json', 'full-stack-developer.agent.json', 'manager.agent.json', 'qe-engineer.agent.json', 'requirements-analyst.agent.json']);
    expect(systemFiles).toEqual(['software-delivery-team.agent-system.json']);
    expect(nestedAgentFiles).toEqual([]);
  });

  for (const f of [...agentFiles, ...nestedAgentFiles]) {
    it(`agent definition ${f} passes loadAgentDefinition (schema + rules)`, () => {
      const { definition, definitionHash } = loadAgentDefinition(join(EXAMPLES_DIR, f));
      expect(definition.metadata.name).toBeTruthy();
      expect(definitionHash).toMatch(/^[0-9a-f]{16}$/);
    });
  }

  for (const f of systemFiles) {
    it(`agent-system definition ${f} passes its separate schema`, () => {
      const definition = JSON.parse(readFileSync(join(EXAMPLES_DIR, f), 'utf8')) as unknown;
      const checked = validateSystemDefinition(definition);
      expect(checked.definition.kind).toBe('agent-system');
      expect(checked.definition.team.members.length).toBeGreaterThan(0);
      expect(checked.definitionHash).toMatch(/^sha256:[0-9a-f]{16}$/);
      // Every member may pin a different specialist: resolve each ref against the
      // example agent whose name@version it names, and prove the pin is exact.
      const catalogue = new Map([...agentFiles, ...nestedAgentFiles].map((f) => {
        const loaded = loadAgentDefinition(join(EXAMPLES_DIR, f));
        return [`${loaded.definition.metadata.name}@${loaded.definition.metadata.version}`, loaded];
      }));
      const refs = checked.definition.team.members.map((m) => m.agentRef);
      const unresolved = refs.filter((ref) => {
        const hit = catalogue.get(ref.agentId.includes('@') ? ref.agentId : `${ref.agentId}@${ref.version}`);
        return !hit
          || ref.version !== hit.definition.metadata.version
          || !String(ref.definitionHash ?? '').replace(/^sha256:/, '').startsWith(hit.definitionHash);
      });
      expect(unresolved, `unresolved pins: ${unresolved.map((r) => `${r.agentId}@${r.version}`).join(', ')}`).toEqual([]);
      const report = validateTeam(checked.definition, {
        resolveAgent: (ref) => {
          const key = ref.agentId.includes('@') ? ref.agentId : `${ref.agentId}@${ref.version}`;
          const hit = catalogue.get(key);
          return hit
            ? { ok: true, value: { agentId: `${ref.agentId}@${hit.definition.metadata.version}`, version: hit.definition.metadata.version, definitionHash: `sha256:${hit.definitionHash}` } }
            : { ok: false, error: `unknown agent ${ref.agentId}` };
        },
      });
      expect(report.ok, report.errors.join('; ')).toBe(true);
      expect(report.warnings).toEqual([]);
    });
  }
});
