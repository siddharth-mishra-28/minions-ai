# A2A, team chat and progress

Every published team is an Agent2Agent (A2A) agent. The platform speaks the JSON-RPC 2.0
binding of the A2A spec, using the v0.3 method names (`message/send`, `message/stream`,
`tasks/get`, `tasks/cancel`, `tasks/list`) and accepting the v1.0 aliases (`SendMessage`,
`SendStreamingMessage`, `GetTask`, `CancelTask`, `ListTasks`) on the same endpoint.

## Discovery

| URL | Card |
| --- | --- |
| `GET /.well-known/agent-card.json` | Platform card: every team as a skill. |
| `GET /a2a` | Alias for the platform card. |
| `GET /a2a/:teamId/.well-known/agent-card.json` (alias `/agent-card.json`) | Team card: workflows, members and their card URLs. |
| `GET /a2a/:teamId/members/:memberId/.well-known/agent-card.json` | Member card: role, reporting line, capabilities. |
| `GET /a2a/health` | Transport probe; reports whether auth is bearer or loopback. |

Cards are public. RPC and task reads are loopback-only unless `A2A_TOKEN` is set; with a
token they require `Authorization: Bearer <token>`.

## RPC

`POST /a2a/:teamId` — team-scoped endpoint.
`POST /a2a/:teamId/members/:memberId` — the same methods, with the operator message
addressed to that member only.

```jsonc
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "message/send",
  "params": {
    "message": {
      "kind": "message",
      "messageId": "msg-1",
      "role": "user",
      "parts": [{ "kind": "text", "text": "Ship the support-desk app." }],
      "contextId": "optional-existing-task-id"
    },
    "metadata": { "workflowId": "delivery", "workspace": "./app" }
  }
}
```

- Without `contextId`, the message starts a new team run and returns that run as an A2A task.
- With `contextId` (a run id), the message is queued for delivery at the recipient's next
  turn. `memberId` scopes it to one member; otherwise every member receives it.
- `message/stream` returns server-sent events: an initial task, then artifact updates and a
  final `status-update` with `final: true`.
- `tasks/get` returns the task with artifacts and history; `tasks/cancel` requests a stop;
  `tasks/list` returns recent runs for the team.

REST conveniences: `GET /a2a/:teamId/tasks` and `GET /a2a/:teamId/tasks/:taskId`.

## Agent-to-agent chat

Team members exchange concise structured messages through the run's message store. They are
not free-form chatter:

- A member emits `replies` in its result JSON. Each reply has a `to` member, a `type`
  (`message`, `review-request`, `review-response`, `handoff`, `question`, `answer`,
  `status`) and a short `body`.
- The orchestrator validates the recipient against the resolved team, the
  `communication.allowPeerToPeer` policy, the message budget and the workflow's communication
  settings. Rejected messages are recorded as `message.rejected` events, never silently lost.
- Messages are persisted, shown in the cockpit's **Conversation** tab, exposed at
  `GET /api/team-runs/:id/messages`, and delivered in the recipient's next prompt under
  "Messages awaiting `<member>`".
- Chat is deliberately small: bodies are bounded (about 500 characters), the prompt asks for
  one or two sentences and no restating of artifacts, replies are capped per turn, and the
  run has a total message budget. Coordination happens through artifacts and progress, not
  long transcripts.

**Linear and hierarchical both support it.** Sequential and parallel workflows use the same
message bus; hierarchical workflows add manager delegation, but specialists may still message
each other when peer-to-peer is enabled. The Team Builder exposes the policy: communication
on/off, peer-to-peer on/off, message budget and routing mode (`auto`, `manager`, `peer`).

## Progress

Each member reports a bounded progress record rather than repeating its status in chat:

- The orchestrator stores a progress row per member (`agent_run_member_progress`) whenever a
  member starts, reports a phase, is blocked or finishes.
- `GET /api/team-runs/:id/progress` returns all member progress (`status`, `percent`, `phase`,
  one-line `summary`, `updated_at`), derived counts and the latest update time.
- `GET /api/team-runs/:id` includes the latest progress per member, and the cockpit shows it
  in the **Progress** tab and on the run timeline.
- Progress survives restarts (SQLite `agent_run_member_progress`) and is included in the run
  export bundle.

The intended loop is: read peers' progress before starting, update your own on meaningful
state changes, send a message only when a peer must act or decide, and write deliverables as
artifacts.
