---
layout: home

hero:
  name: Minions-ai
  text: A software factory of custom AI agent teams
  tagline: A fully configurable software factory of custom AI agent teams — ship to market faster, and let every run make the next one smarter.
  image:
    src: /media/minions-ai-logo.svg
    alt: Minions-ai
  actions:
    - theme: brand
      text: Download for Windows
      link: https://siddharth-mishra-28.github.io/minions-ai/downloads/minions-ai-win-x64.exe
    - theme: alt
      text: Read the README
      link: /README
    - theme: alt
      text: All platforms
      link: /#download

features:
  - title: One executable, three modes
    details: Run the cockpit with ui, a headless API with serve, or script everything with the CLI. The same engine and the same audit trail.
  - title: Your roles, your models
    details: Every role, model, prompt, tool, permission, memory scope and workflow is versioned JSON you control. The shipped delivery team is a template.
  - title: Verified delivery
    details: Requirements, architecture, implementation and independent QA with output contracts, bounded rework, artifacts, approvals and exportable evidence.
  - title: Self-improving memory
    details: Episodes, lessons and feedback are recalled into later runs, so experience compounds instead of resetting with each task.
  - title: Local-first security
    details: Loopback by default, AES-256-GCM credential vault, tool policies, approvals and no provider keys in the browser.
  - title: MCP and A2A
    details: Extend agents with MCP servers and let external agents drive published teams over A2A JSON-RPC.
---

## Download

| Platform | Stable download |
| --- | --- |
| **Windows x64** | [minions-ai-win-x64.exe](https://siddharth-mishra-28.github.io/minions-ai/downloads/minions-ai-win-x64.exe) |
| **macOS Apple Silicon** | [minions-ai-mac-arm64.zip](https://siddharth-mishra-28.github.io/minions-ai/downloads/minions-ai-mac-arm64.zip) |
| **macOS Intel** | [minions-ai-mac-x64.zip](https://siddharth-mishra-28.github.io/minions-ai/downloads/minions-ai-mac-x64.zip) |
| **Linux x64** | [minions-ai-linux-x64.tar.gz](https://siddharth-mishra-28.github.io/minions-ai/downloads/minions-ai-linux-x64.tar.gz) |

These files are rebuilt from the latest commit on every push. Checksums: [SHA256SUMS](https://siddharth-mishra-28.github.io/minions-ai/downloads/SHA256SUMS).

Double-click the Windows executable, or unzip the macOS download and open **Minions-ai.app**, to start the cockpit in your default browser. From a terminal the explicit forms are:

```bash
# Windows
minions-ai.exe ui

# macOS (inside the app bundle)
./Minions-ai.app/Contents/MacOS/minions-ai ui

# Linux (after extracting the tarball)
cd minions-ai-linux-x64 && ./minions-ai ui
```

On Linux, `./install.sh` adds the binary to `~/.local/bin` and the Minions-ai icon to your application menu.

The first launch opens the setup wizard. Pick your provider, test the connection, and start the starter Software Delivery Team.

## Start here

- [Full README](/README) — purpose, modes, downloads, cockpit tour, CLI, API, definitions, memory, MCP, A2A and troubleshooting.
- [Agent teams guide](/TEAMS-GUIDE) — from a clean install to a finished, auditable team run.
- [CLI reference](/CLI) — every command and option.
- [REST API reference](/API) — the headless surface and Swagger.
- [Security](/SECURITY) — threat model, credential handling and binary verification.

<p align="center">
  <img src="/media/team-run.gif" alt="A Minions-ai team run" width="820">
</p>
