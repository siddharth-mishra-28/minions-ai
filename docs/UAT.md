# Acceptance record — Minions-ai 1.0.0

This is the user-acceptance record for **Minions-ai 1.0.0**. The npm tarball below predates the public executable rename; the shipped binary is `minions-ai`. It documents what was
verified, how, and what was found and fixed — driven like an end user: custom agent and
team definition JSONs authored against a real provider (Xiaomi MiMo, BYOK), complex
long-horizon coding tasks, and every delivered product verified by a harness that never
trusts the agent's own report.

## What "accepted" means here

One definition JSON runs unchanged through **every** operational mode — browser cockpit,
REST API, CLI and GitLab CI — both as standalone agents and as agent teams. The same
custom BYOK definitions (`helios-engineer.agent.json`, `helios-trio.agent-system.json`)
and the shipped defaults (`full-stack-engineer.agent.json`,
`software-delivery-team.agent-system.json`) were each driven through the modes below.

### Long-horizon deliveries — Helios Desk

Every mode delivered a production-grade support-desk service (zero-dependency Node.js:
atomic JSON persistence, `node:http` API, CLI, seed, full `node:test` suite) from the
same task brief, and each delivery was independently verified (`ci/verify-service.mjs`:
product tests, fresh boot on an isolated database, HTTP contract, CLI, seed idempotency).

| Mode | Kind | Definition | Result |
| --- | --- | --- | --- |
| CLI | standalone agent | custom `helios-engineer` (BYOK) | **PASS 32/32** independent checks |
| REST API | standalone agent | custom `helios-engineer` (same JSON) | **PASS 32/32** after one repair round (28/32 → agent fix → 32/32) |
| Browser | standalone agent | custom `helios-engineer` (same JSON) | **PASS 32/32** independent checks |
| Browser | team, hierarchical | custom `helios-trio` (BYOK) | **PASS 27/27** run-record + **32/32** independent |
| CLI | team, sequential | custom `helios-trio` (BYOK) | **PASS 29/29** run-record + **32/32** independent |
| REST API | team, manager-led | shipped `software-delivery-team` | **PASS 30/30** run-record + **32/32** independent |
| GitLab CI | standalone + team | shipped agent + shipped team | see `evidences/gitlab/` (final pipeline on the release commit) |

### Portability matrix — same JSON, every mode

Compatibility runs (real turns through the same code paths, deterministic objectives)
complete the matrix where a long delivery was not needed to prove the mode:

| Definition JSON | CLI | API | UI (browser) | GitLab CI |
| --- | --- | --- | --- | --- |
| `helios-engineer.agent.json` (custom BYOK) | ✅ long | ✅ long | ✅ long | — |
| `helios-trio.agent-system.json` (custom BYOK) | ✅ long | ✅ done, 3 artifacts | ✅ long | — |
| `full-stack-engineer.agent.json` (shipped) | ✅ | ✅ | ✅ | ✅ |
| `software-delivery-team.agent-system.json` (shipped) | ✅ done, 3 artifacts, 2 handoffs | ✅ long | ✅ browser-launched | ✅ |

### Feature walks (every surface)

| Walk | Result |
| --- | --- |
| REST + A2A acceptance — every route family, runs, chat, platform, MCP, memory, teams, A2A JSON-RPC, security (`ci/api-acceptance.mjs`) | **PASS 110/110** |
| Cockpit team surface — card, both workflow designers, JSON tab, run modal, run explorer, all run tabs, artifact download, chat (`ci/ui-verify.mjs`) | **PASS 31/31** |
| Cockpit exhaustive walk — onboarding + real provider, settings, agent import/publish, run detail, dashboard, audit, MCP, chat, palette, theme, projects, responsive, `/ui` 404 (`ci/cockpit-e2e.mjs`) | **PASS 25/25** |
| Standalone agent proof — chat + run per shipped agent outside a team (`ci/agent-standalone.mjs`) | **PASS 7/7** |
| CLI command sweep — validate, list, show, history, chat, memory, MCP, team, A2A card (live turns) | PASS |
| Fresh install — `reset --new-install`, BYOK `init` with live `/models` probe, base agent + sample team seeded and pinned | PASS |

## Defects found during acceptance and fixed

All are product defects — infrastructure slowness (a low-powered self-hosted runner,
variable provider latency) is called out separately below and is not counted here.

1. **Chat turns sent an invalid SDK send mode.** `executeChatTurn` sent `mode: 'resume'`,
   which the Copilot SDK rejects (it accepts `enqueue`/`immediate`; session continuation
   is `resumeSession`). Every chat turn — CLI, API, cockpit — failed. Fixed in
   `src/execution/chat-runner.ts`.
2. **A booting server stole runs being executed by other processes.** Stale-run recovery
   marked every non-terminal run `interrupted`, and the CLI waiter then treated the row
   as truth and killed its own engine mid-node — losing in-flight work. Fixed with a run
   heartbeat (`agent_system_runs.heartbeat_at`, additive migration) that recovery checks,
   and waiters that follow the engine they own (`src/store/teams.ts`,
   `src/execution/team/engine.ts`, `src/cli.ts`).
3. **The sample team's product landed in `members/<id>/` while CI verified the workspace
   root.** A delivery team shares one repository; the sample's members now declare
   `workspace: shared` so the product lands where the brief and the verifier expect it.
4. **Workflow dead-end on out-of-contract verdicts.** Members returned `blocked` and
   `done` where their instructions said `passed`/`failed`; with no matching transition
   the engine correctly failed finished runs at the last node. The shipped sample now
   routes the full verdict vocabulary — a positive family (`passed, done, complete,
   completed, success, accepted, approved, ok`) to completion and a negative family
   (`failed, blocked, rejected, changes-requested, error, cancelled, stopped`) to the
   bounded rework loop.
5. **Run budgets that could not fit their own turn caps.** The sample's 90-minute
   `maxDurationMs` could not hold its own 60-minute turn cap plus one retried turn: a
   GitLab `team_delivery` run died with "maximum run duration exceeded" after
   requirements + a failed turn + a retry, before testing. The shipped agent now caps
   turns at 90 minutes (observed slow-provider turns exceed 60), the workflows allow
   3h30m (two turns per node plus margin) and the CI job runs a 215-minute budget.
6. **Publish rejected the shipped example on a fresh install.** `init` pins the
   shipped agents to your provider (changing their content hash), so the team file's
   own pins drifted and the README's self-contained CLI flow (`team run --definition`)
   failed with "definition drift". `create`/`update` now pin members to the registered
   definitions exactly as the publish contract documents; `validate` stays strict so
   drift is still auditable.

The independent verifier also caught a delivered product with a CLI that rejected
global options before the subcommand (28/32). The failure report was handed back to
the same agent over the same workspace (one repair turn) and the re-verified product
passed 32/32 — the repair loop works in practice, not just in design.

## Infrastructure notes (not product defects)

- The GitLab runner is a low-powered self-hosted machine; jobs there take longer than on
  a workstation. Job budgets absorb this and no product behavior depends on runner speed.
- Provider latency varies 1.7–4× within an hour. Turn budgets live in the definition
  JSONs (`runtime.turnTimeoutMs`) and are carried to every mode unchanged; long runs
  recover through node retries, manager re-delegation and `team resume`.
- On a shared shell runner a forgotten server from an older job once answered a smoke
  test instead of the freshly booted one (`EADDRINUSE`). The CI job now claims its port,
  fails fast when it cannot, and stops its server on exit.

## Build, verify and publish locally

Prerequisites: Node.js 22.12+, npm 10+; Java 17+ and Maven 3.9+ only for generated apps.

```bash
# 1. Clean install and full checks
npm ci
npm --prefix web ci
npm run typecheck
npm run typecheck:web
npm test
npm run test:web

# 2. Build one artifact (prepack rebuilds dist/ and dist/web automatically)
npm run build
npm pack                      # -> minions-assembler-1.0.0.tgz

# 3. Inspect exactly what will be published
npm pack --dry-run
tar -tzf minions-assembler-1.0.0.tgz | grep -E 'dist/web/index.html|examples/'

# 4. Install the built artifact and use it as a customer would
npm install -g ./minions-assembler-1.0.0.tgz
minions-ai --version
minions-ai init            # provider + key, then the base agent and sample team
minions-ai serve --port 3100

# 5. Run the same definition JSONs through any mode
minions-ai run --agentDefinition examples/full-stack-engineer.agent.json \
  --task "..." --approval autopilot --no-stream
minions-ai team run --team software-delivery-team --workflow agile-delivery \
  --task "$(cat ci/tasks/team-delivery.md)" --workspace ./app --follow

# 6. Publish when ready
npm publish --dry-run
npm publish --access public
```

## CI mode

The acceptance pipeline ran `package → generate_backend → generate_frontend → team_delivery →
app_check → cockpit_check` on one serialized shell runner. The only build happened in
`package`; every later job installed that same tarball — the pipeline exercised the end-user
path with the packaged artifact. Evidence from the runs was retained with the acceptance
workspace, not shipped in this repository.

## Evidence map

| Evidence | Path (acceptance workspace) |
| --- | --- |
| Acceptance index (this round's matrix and reports) | `evidences/README.md` |
| CLI standalone delivery + independent verification | `evidences/cli/standalone/` |
| UI team delivery (browser) + record + independent verification | `evidences/ui/team/` |
| REST + A2A walk transcript and report | `evidences/api/` |
| Cockpit walks (exhaustive + team surface) | `evidences/ui/` |
| Standalone agent proof, CLI sweep, fresh install | `evidences/standalone/`, `evidences/cli/sweep/`, `evidences/fresh-install/` |

Historical acceptance rounds (November 4–11, 2026) covered an earlier shipped set and
produced the browser recordings in `docs/media/`; their evidence lived under `evidence/`
and has been superseded by this round.
