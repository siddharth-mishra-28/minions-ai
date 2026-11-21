# CLI reference

Use `minions-ai.exe` on Windows and `./minions-ai` on macOS/Linux. The examples below use the Windows name; substitute the binary you downloaded. Every command accepts `--help` after the command name.

```text
minions-ai --version
minions-ai --help
```

The default database is the platform data directory (`%LOCALAPPDATA%\MinionsAI\minion.db`, `~/Library/Application Support/MinionsAI/minion.db`, or `$XDG_DATA_HOME/minions-ai/minion.db`). Every stateful command also accepts `--db <path>`.

## Start the product

| Command | What it does |
| --- | --- |
| `minions-ai ui` | Start the cockpit and open the default browser. |
| `minions-ai ui --no-open` | Start the cockpit without opening a browser. |
| `minions-ai serve` | Start cockpit + REST API + Swagger + A2A without opening a browser. |
| `minions-ai serve --open` | Same, then open the cockpit. |

Options: `--port <n>` (default `3100`), `--db <path>`.

URLs: `/` cockpit, `/docs` Swagger UI, `/openapi.json`, `/a2a` platform card, `/.well-known/agent-card.json`.

## First-run and reset

```bash
minions-ai init
minions-ai init --provider xiaomi --model mimo-v2.6-flash --api-key-env MIMO_API_KEY
minions-ai init --provider openai --base-url https://api.openai.com/v1 --model gpt-4.1 --api-key-stdin
minions-ai init --provider ollama --base-url http://127.0.0.1:11434/v1 --model llama3.1 --skip-test
```

`init` accepts `--db`, `--provider`, `--name`, `--base-url`, `--model`, `--api-key-env`, `--api-key-stdin`, `--skip-test`, `--no-seed-agents` and `--json`. The key is read from a hidden prompt, an environment variable or stdin — never from argv.

```bash
minions-ai reset --new-install --yes
minions-ai reset --new-install --yes --no-backup --no-seed-defaults
```

`reset` accepts `--db`, `--workspace`, `--data-dir`, `--new-install`, `--no-backup`, `--no-seed-defaults`, `--yes` and `--json`. `--yes` is mandatory. A timestamped database backup is kept by default; treat it as sensitive.

## Agent definitions

```bash
minions-ai validate --agentDefinition examples/full-stack-developer.agent.json
minions-ai run --agentDefinition examples/full-stack-developer.agent.json \
  --task "Reply with exactly: OK" \
  --approval autopilot --no-stream --output-format json
minions-ai import-md --file ./profiles/reviewer.agent.md
minions-ai import-md --file ./profiles/reviewer.agent.md --no-register
```

`run` options: `--task`, `--sessionId`, `--resume`, `--no-stream`, `--output-format text|json`, `--share <path>`, `--db`, `--runDir`, `--yes`, `--approval autopilot|strict`, `--audit-level minimal|default|full`.

`--yes` is an explicit CI approval for policies that allow approve-all; it is equivalent to `--approval autopilot`.

## Registry and history

```bash
minions-ai list
minions-ai show full-stack-developer@1.0.0
minions-ai history
minions-ai history --agentId full-stack-developer@1.0.0
```

All accept `--db`. `show` prints the stored definition with secret fields redacted.

## Teams

```bash
minions-ai team validate --definition examples/software-delivery-team.agent-system.json
minions-ai team publish --definition examples/software-delivery-team.agent-system.json
minions-ai team publish --definition examples/software-delivery-team.agent-system.json --publish-version 2.1.0
minions-ai team list
minions-ai team show software-delivery-team
```

```bash
minions-ai team run --team software-delivery-team --workflow agile-delivery \
  --task "Build the support-desk app in SPEC.md" \
  --workspace ./app --follow
minions-ai team run --definition examples/software-delivery-team.agent-system.json \
  --task "Build the support-desk app in SPEC.md" --no-wait
```

`team run` options: `--team`, `--definition`, `--task`, `--workflow`, `--workspace`, `--max-duration-ms`, `--no-wait`, `--follow`, `--output-format text|json`, `--db`. It waits for the engine to settle unless `--no-wait` is passed.

```bash
minions-ai team status <runId>
minions-ai team stop <runId>
minions-ai team resume <runId> --follow
minions-ai team export <runId> --out ./team-run.json
```

`team stop` only works while the same process is executing the run. `team resume` takes `--no-wait`, `--follow`, `--output-format` and `--db`.

## Chat

```bash
minions-ai chat create --agent full-stack-developer@1.0.0
minions-ai chat create --agent full-stack-developer@1.0.0 --title "Checkout review"
minions-ai chat list
minions-ai chat send --thread <threadId> --message "Review the checkout flow"
minions-ai chat read --thread <threadId>
```

`chat send` accepts `--timeout-ms` (default 2700000) and `--db`. Threads persist their Copilot session so later turns resume the same conversation.

## Memory

```bash
minions-ai memory index --root .
minions-ai memory index --root ./app --dataset platform
minions-ai memory search "checkout flow" --k 5 --hops 1
minions-ai memory search "checkout flow" --json
minions-ai memory recall --agent full-stack-developer@1.0.0 --task "Add refunds"
minions-ai memory stats
minions-ai memory lesson --trigger "the test suite fails on a missing lockfile" \
  --text "Run the install step before tests."
minions-ai memory improve
minions-ai memory promote --id <nodeId>
minions-ai memory forget --id <nodeId>
minions-ai memory forget --dataset platform
minions-ai memory config
minions-ai memory config --set '{"recall":{"k":12},"codeGraph":{"enabled":true}}'
```

`memory index` accepts `--root`, `--dataset`, `--no-symbols`, `--db`. `memory search` accepts `--dataset`, `--k`, `--hops`, `--json`. `memory recall` accepts `--agent`, `--task`, `--db`.

## MCP

```bash
minions-ai mcp register --name docs --config ./mcp/docs.json --probe
minions-ai mcp register --name docs --config '{"command":"npx","args":["-y","@scope/server"]}'
minions-ai mcp-list
```

`mcp register` accepts `--name`, `--config` (JSON string or file path), `--description`, `--probe`, `--db`. Referencing a registered server from a definition:

```json
{ "mcp": { "use": ["docs"] } }
```

## A2A inspection

```bash
minions-ai team a2a card software-delivery-team --base-url http://127.0.0.1:3100
minions-ai team a2a task <runId>
```

`team a2a card` prints the card a client would fetch; `team a2a task` prints a run as an A2A task with status, artifacts, history and progress.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Completed successfully. |
| `2` | Validation, configuration or not-found error. |
| `3` | Runtime, provider or failed-run error. |
| `4` | Permission/approval error. |
