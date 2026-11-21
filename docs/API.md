# REST API reference

Start a server with `minions-ai.exe serve` (or `ui`). The default origin is `http://127.0.0.1:3100`. The exhaustive, generated contract is always available at:

```text
GET /openapi.json
GET /docs            Swagger UI
GET /api/status      server, version, database and workspace
```

The API and cockpit share one origin. Mutating requests are checked against the loopback host allow-list and same-origin policy. If `MINIONS_API_TOKEN` is set, every API request needs `Authorization: Bearer <token>`. A2A RPC uses `A2A_TOKEN` independently.

## Agents

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/agents` | List registered agents |
| `POST` | `/api/agents` | Register/update a definition |
| `GET` | `/api/agents/:id` | Get one agent |
| `PUT` | `/api/agents/:id` | Update an agent |
| `DELETE` | `/api/agents/:id` | Delete an agent |
| `POST` | `/api/agents/validate` | Validate without saving |
| `POST` | `/api/agents/draft` | Draft a definition |
| `POST` | `/api/agents/:id/clone` | Clone under a new name |
| `POST` | `/api/agents/import` | Import a markdown/JSON profile |
| `POST` | `/api/agents/elaborate` | Expand a definition with the designer |
| `GET` | `/api/agents/:id/definition` | Definition for editing |
| `GET` | `/api/agents/:id/runs` | Runs for one agent |

## Headless runs

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/agent-definitions/runs` | Run a definition without registering it first |
| `POST` | `/api/agents/:id/runs` | Run a registered agent |
| `GET` | `/api/runs` | List recent runs |
| `GET` | `/api/runs/:id` | Run detail |
| `GET` | `/api/runs/:id/events` | Audit events |
| `GET` | `/api/runs/:id/stream` | SSE stream |
| `POST` | `/api/runs/:id/stop` | Stop a run |
| `GET` | `/api/runs/:id/definition` | Definition snapshot |

Minimal one-agent request:

```json
{
  "definition": {
    "schemaVersion": "1.0",
    "metadata": { "name": "smoke", "version": "1.0.0" },
    "task": { "prompt": "Reply with exactly: OK" }
  },
  "taskOverride": "Reply with exactly: OK",
  "approvalMode": "autopilot",
  "runDir": "./runs/smoke"
}
```

The response includes `runId`, `text`, `sessionId` and `traceId`.

## Teams and team runs

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/teams` | List teams |
| `POST` | `/api/teams` | Create/register a team |
| `GET` | `/api/teams/:id` | Team + validation + versions |
| `PUT` | `/api/teams/:id` | Update a draft |
| `DELETE` | `/api/teams/:id` | Delete a team with no runs |
| `POST` | `/api/teams/:id/validate` | Validate pins and graph |
| `POST` | `/api/teams/:id/publish` | Publish an immutable version |
| `GET` | `/api/teams/:id/versions` | Published version history |
| `POST` | `/api/teams/:id/runs` | Start a run from the published version |

Run inspection:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/team-runs` | List team runs |
| `GET` | `/api/team-runs/:id` | Snapshot, nodes, sessions, artifacts, handoffs |
| `GET` | `/api/team-runs/:id/events` | Full event timeline |
| `GET` | `/api/team-runs/:id/stream` | SSE from `?after=` |
| `GET` | `/api/team-runs/:id/progress` | Per-member progress |
| `GET` | `/api/team-runs/:id/messages` | Team conversation |
| `POST` | `/api/team-runs/:id/messages` | Add an operator message |
| `GET` | `/api/team-runs/:id/artifacts` | Deliverables |
| `GET` | `/api/team-runs/:id/artifacts/:artifactId/content` | Artifact body |
| `GET` | `/api/team-runs/:id/handoffs` | Handoff ledger |
| `POST` | `/api/team-runs/:id/handoffs/:handoffId` | Accept/reject a handoff |
| `POST` | `/api/team-runs/:id/stop` | Stop safely |
| `POST` | `/api/team-runs/:id/resume` | Resume an interrupted run |
| `GET` | `/api/team-runs/:id/export` | Complete run bundle |

## Chat

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/chat/agents` | Agents available for chat |
| `POST` | `/api/chat/threads` | Create a thread |
| `GET` | `/api/chat/threads` | List threads |
| `GET` | `/api/chat/threads/:id` | Thread + messages |
| `DELETE` | `/api/chat/threads/:id` | Delete a thread |
| `POST` | `/api/chat/threads/:id/messages` | Send a message |
| `GET` | `/api/chat/threads/:id/events` | Thread events |
| `GET` | `/api/chat/threads/:id/stream` | SSE stream |
| `GET` | `/api/chat/threads/:id/export` | Export the thread |
| `POST` | `/api/chat/threads/:id/cancel` | Cancel the active turn |

## Memory

| Method | Path | Purpose |
| --- | --- | --- |
| `GET`/`PUT` | `/api/memory/config` | Platform memory defaults |
| `GET` | `/api/memory/stats` | Counts |
| `GET` | `/api/memory/datasets` | Datasets |
| `GET`/`POST` | `/api/memory/nodes` | Read/upsert nodes |
| `DELETE` | `/api/memory/nodes/:id` | Delete a node |
| `POST` | `/api/memory/search` | Recall |
| `GET` | `/api/memory/graph` | Graph view |
| `POST` | `/api/memory/index` | Index a code root |
| `GET` | `/api/memory/episodes` | Episodes |
| `POST` | `/api/memory/lessons` | Record a lesson |
| `POST` | `/api/memory/feedback` | Record feedback |
| `POST` | `/api/memory/improve` | Decay/promote/rebuild |
| `POST` | `/api/memory/promote` | Promote to the shared dataset |
| `POST` | `/api/memory/forget` | Delete by id or dataset |

## MCP

| Method | Path | Purpose |
| --- | --- | --- |
| `GET`/`POST` | `/api/mcp` | List/register servers |
| `GET`/`DELETE` | `/api/mcp/:name` | Inspect/remove a server |
| `POST` | `/api/mcp/probe` | Probe without saving |
| `POST` | `/api/mcp/:name/tools` | Refresh tools |
| `POST` | `/api/mcp/oauth/start` | Start OAuth |
| `GET` | `/api/mcp/oauth/status` | OAuth status |
| `GET` | `/api/mcp/oauth/callback` | OAuth callback |

## Platform, providers and audit

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/bootstrap` | First-load state |
| `GET` | `/api/settings` | Retention, approvals, defaults |
| `GET`/`POST` | `/api/providers` | List/save providers |
| `DELETE` | `/api/providers/:id` | Delete a provider |
| `POST` | `/api/providers/:id/default` | Set the default |
| `POST` | `/api/providers/:id/test` | Test a saved provider |
| `GET` | `/api/providers/:id/models` | Discover models |
| `POST` | `/api/providers/test` | Test unsaved credentials |
| `GET`/`POST` | `/api/projects` | Project list/add |
| `GET` | `/api/projects/:id/agents` | Agent profiles in a project |
| `GET` | `/api/fs/browse` | Workspace browser |
| `GET`/`POST` | `/api/approvals` | Approval queue/decision |
| `GET` | `/api/retention` | Retention settings |
| `POST` | `/api/retention/purge` | Run a sweep |
| `GET` | `/api/metrics/daily` | Daily totals |
| `GET` | `/api/audit/runs` | Audit index |
| `GET` | `/api/audit/runs/:id/export` | Audit export |
| `GET` | `/api/credentials` | Credential names only |
| `POST`/`DELETE` | `/api/credentials` | Store/remove credentials |

## A2A

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/.well-known/agent-card.json` | Platform card |
| `GET` | `/a2a` | Platform card alias |
| `GET` | `/a2a/:teamId/agent-card.json` | Team card |
| `GET` | `/a2a/:teamId/members/:memberId/agent-card.json` | Member card |
| `GET` | `/a2a/health` | Transport probe |
| `POST` | `/a2a/:teamId` | JSON-RPC (`message/send`, `message/stream`, `tasks/*`) |
| `POST` | `/a2a/:teamId/members/:memberId` | Member-scoped JSON-RPC |
| `GET` | `/a2a/:teamId/tasks` | Recent tasks |
| `GET` | `/a2a/:teamId/tasks/:taskId` | Task detail |

See [A2A.md](A2A.md) for request envelopes, aliases, task states and artifact mapping.

## Errors

Errors are JSON with an HTTP status:

```json
{ "error": "message", "details": "optional" }
```

`400` validation, `401` missing/incorrect token, `403` cross-origin or policy refusal, `404` not found, `409` conflict (unpublished team, run already terminal), `429` provider rate limit where surfaced, `500` runtime failure. Provider failures include the upstream status/message in the run error and audit trail.
