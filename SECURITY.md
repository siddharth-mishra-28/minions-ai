# Security

## Reporting a vulnerability

Open a private security advisory in the repository rather than a public issue. Include the
version, the command or endpoint involved and a minimal reproduction. Please do not attach
real provider keys, tokens or user data.

## Binary downloads

Release executables are unsigned unless the release notes say otherwise. Windows SmartScreen and
macOS Gatekeeper may warn on first launch. Download only from the official
[releases page](https://github.com/siddharth-mishra-28/minions-ai/releases), compare the published
`SHA256SUMS`, and prefer a signed build when one is available. The executable extracts native
SQLite and Copilot runtime files into a versioned cache; the extraction verifies SHA-256 hashes
and rejects path traversal.

## Supported versions

The latest 1.x release receives security fixes.

## Security model

- **Local-first.** The server binds `127.0.0.1` by default. `--host` can expose it; only do
  that behind a trusted reverse proxy or with `MINIONS_API_TOKEN` set.
- **Host and Origin checks.** A loopback host allow-list and same-origin checks protect
  state-changing HTTP requests. A configured bearer token is required for every API call.
- **Provider credentials.** Keys are sealed with AES-256-GCM using a locally generated
  `.master-key` (owner-readable) and are never returned by the API. The `init` command reads
  keys from a hidden prompt, `--api-key-env` or `--api-key-stdin`, never from argv.
- **A2A.** Discovery cards are public; JSON-RPC and task reads are loopback-only unless
  `A2A_TOKEN` is set, in which case a bearer token is required.
- **Agent tools.** Definitions carry an explicit builtin tool policy; destructive tools are
  denied unless the definition opts in and the operator approves. Workspace writes stay under
  the configured workspace.
- **Data.** SQLite databases, run artifacts, chat bodies and memory live in the platform data
directory (`%LOCALAPPDATA%\MinionsAI`, `~/Library/Application Support/MinionsAI`, or
`$XDG_DATA_HOME/minions-ai`) and the workspace. Packaged builds extract native runtime files
into a versioned cache. They are not uploaded anywhere by the platform. Run exports are written
where the operator asks.
- **Secrets in CI.** Use CI variables or a secret store; do not commit `.env`, `.master-key`
  or exported run bundles.

## First-run and reset

`minions-ai init` stores exactly what the operator enters. `reset --new-install --yes` deletes
provider rows, credentials, chats, runs, teams, memory and `.master-key`, keeping a timestamped
database backup under the platform data directory unless `--no-backup` is passed. Treat that
backup as sensitive.
