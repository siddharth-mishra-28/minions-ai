# Building the Minions-ai executable

This page is for contributors and release maintainers. If you just want to run Minions-ai, download the executable from the [latest release](https://github.com/siddharth-mishra-28/minions-ai/releases/latest) and follow the [README](../README.md).

## What the binary contains

Minions-ai is **one executable per OS/architecture**. It is not a directory of loose files. The executable contains:

| Layer | Contents | Runtime form |
| --- | --- | --- |
| App | CLI, Fastify server, engines, stores | V8 bytecode bundled by `@yao-pkg/pkg` |
| Cockpit | React/Vite build from `dist/web` | Embedded ZIP, extracted to cache |
| Swagger UI | `@fastify/swagger-ui/static` | Embedded ZIP, extracted to cache |
| Examples | Shipped role agents and sample team | Embedded ZIP, extracted to cache |
| SQLite | `better_sqlite3.node` prebuild | Embedded ZIP, extracted to cache |
| Copilot runtime | `@github/copilot-sdk-<platform>` runtime and prebuilds | Embedded ZIP, extracted to cache |

The app bundle is bytecode, so the application source is not shipped as readable JavaScript. This is **deterrence, not DRM**: V8 bytecode can be reverse-engineered by a determined attacker. Native addons (`.node`) and the Copilot runtime cannot be loaded from a virtual filesystem, so they are shipped inside the executable and extracted once to a versioned cache. The only honest claim is "single self-extracting executable"; it is not "no files ever touch disk."

The packager is **`@yao-pkg/pkg`** (the maintained fork). Newer `nexe` 5 beta releases have known Windows Node 22 `vcbuild` failures, and the pkg path produces working Windows/macOS/Linux artifacts with V8 bytecode. The build script keeps the packaging seam in one file (`scripts/build-exe.mjs`) if that changes.

## Build prerequisites

- Node.js **22.12+** (Node 24 is used by the current release pipeline).
- The platform toolchain needed by the installed dependencies.
- For a target build, the matching `@github/copilot-sdk-<platform>` package and `better-sqlite3` prebuild must be installed. Build each target on its native OS; do not cross-compile the native pieces.
- macOS signing/notarization and Windows Authenticode are optional and require your own certificates.

## Source setup

```bash
npm ci --no-audit --no-fund
npm --prefix web ci --no-audit --no-fund
npm run typecheck
npm test
npm --prefix web test
```

`npm run verify` runs all four checks. `npm run build` compiles the server and builds the cockpit into `dist/web`.

## Build one executable

```bash
npm run build:exe:win     # Windows x64   -> release/minions-ai-win-x64.exe
npm run build:exe:mac     # macOS arm64   -> release/Minions-ai.app + minions-ai-mac-arm64.zip
npm run build:exe:linux   # Linux x64     -> release/minions-ai-linux-x64.tar.gz
```

Or pass an explicit target:

```bash
node scripts/build-exe.mjs --target win-x64
node scripts/build-exe.mjs --target mac-arm64
node scripts/build-exe.mjs --target mac-x64
node scripts/build-exe.mjs --target linux-x64
node scripts/build-exe.mjs --target linux-arm64
```

The script:

1. Builds the cockpit if `dist/web/index.html` is missing.
2. Bundles `src/cli.ts` with esbuild to minified CJS at `build/exe/app.cjs`, with no source map.
3. Packages each asset group as a store-mode ZIP plus SHA-256 manifest:
   - `web`
   - `examples`
   - `swagger`
   - `native` (`better_sqlite3.node` for the target)
   - `copilot` (platform runtime, minus duplicate SDK/docs/type files)
   - `licenses`
4. Invokes pkg with `bytecode: true`, GZip compression and the asset globs.
5. On Windows, replaces the executable's icon resources with `docs/media/minions-ai.ico`.
6. On macOS, wraps the binary in `Minions-ai.app` with `Contents/Resources/minions-ai.icns`, generated from `docs/media/minions-ai-icon.png`, and archives the bundle with `ditto` as `minions-ai-<target>.zip`.
7. On Linux, stages the binary with `minions-ai.desktop`, `install.sh` and a hicolor icon set generated from `docs/media/minions-ai-icon.png`, then archives them as `minions-ai-<target>.tar.gz`.
8. Writes the shipped archive and its `.sha256` file under `release/`.

The icon master is `docs/media/minions-ai-icon.png` (1024 px, rendered from `docs/media/minions-ai-icon.svg`). `scripts/icons.mjs` resizes it and assembles the macOS `.icns` with Node's `zlib` only, so no native image tooling is needed on any build host.

pkg turns the app into bytecode and embeds the asset ZIPs under the executable's snapshot path. At runtime, `src/core/embedded-assets.ts` verifies every extracted file against its manifest, rejects traversal paths, extracts into a temporary sibling directory, and atomically renames it into the versioned cache. The marker `.ready` makes later launches instant.

### Where assets go at runtime

| Packaged OS | Data | Cache |
| --- | --- | --- |
| Windows | `%LOCALAPPDATA%\MinionsAI` | `%LOCALAPPDATA%\MinionsAI\cache\runtime\<version>-<platform>-<arch>\assets` |
| macOS | `~/Library/Application Support/MinionsAI` | `~/Library/Caches/MinionsAI/runtime/...` |
| Linux | `$XDG_DATA_HOME/minions-ai` | `$XDG_CACHE_HOME/minions-ai/runtime/...` |

Overrides: `MINIONS_DATA_DIR`, `MINIONS_CACHE_DIR`. `MINIONS_EMBEDDED_DIR` is a build/debug escape hatch that points at a staging directory containing the asset ZIPs.

The packaged build sets `COPILOT_CLI_PATH` to the extracted wrapper before every `CopilotClient` construction. SQLite loads the extracted `better_sqlite3.node` through `MINIONS_SQLITE_NATIVE`; in a source checkout it uses the normal `better-sqlite3` bindings.

## Release artifacts

The workflow publishes stable names so `releases/latest/download/...` never changes:

| Asset | Platform |
| --- | --- |
| `minions-ai-win-x64.exe` | Windows x64 |
| `minions-ai-mac-arm64.zip` | macOS Apple Silicon |
| `minions-ai-mac-x64.zip` | macOS Intel |
| `minions-ai-linux-x64.tar.gz` | Linux x64 |
| `SHA256SUMS` | All of the above |

The macOS zip contains `Minions-ai.app` with the Minions-ai icon; open the app or run `Minions-ai.app/Contents/MacOS/minions-ai`. The Linux tarball extracts to `minions-ai-linux-x64/` with the binary, `minions-ai.desktop`, an icon set and `install.sh`, which installs the binary under `~/.local/bin` with a menu entry. Windows ships the `.exe` directly. The workflow builds on native runners (`windows-latest`, `macos-15`, `macos-15-intel`, `ubuntu-latest`), runs `--version`/`--help`, starts `serve` and checks `/api/status`, verifies the bundle/tarball layout, then uploads the artifact. A `v*` tag creates the GitHub Release and uploads the stable assets.

## GitHub Actions

`.github/workflows/release.yml` has three jobs:

- **build** — matrix across Windows, macOS ARM and Linux; installs dependencies, builds the cockpit and executable, smokes the CLI/server, and uploads the artifact.
- **release** — on a `v*` tag, downloads all artifacts, verifies their checksums, creates the release, uploads stable names and writes `SHA256SUMS`.
- **pages** — builds the VitePress site from this README and `docs/`, then deploys it with GitHub Pages.

Permissions are `contents: write`, `pages: write` and `id-token: write`. Actions uses the built-in `GITHUB_TOKEN`; no personal access token is stored in the repository. The Pages URL is:

```text
https://siddharth-mishra-28.github.io/minions-ai/
```

## Signing

Unsigned Windows binaries trigger SmartScreen; unsigned macOS app bundles trigger Gatekeeper. The project does not ship certificates.

For Windows Authenticode, set the certificate in the release environment and sign the `.exe` with `signtool` before upload. For macOS, sign `Minions-ai.app` with a Developer ID Application certificate, then notarize and staple the zip before upload. Keep certificate material in CI secrets, never in the repository. Document in the release notes whether a build is signed.

## Verification

From a clean temporary directory with no `node_modules`, `dist` or `examples`:

```bash
minions-ai.exe --version
minions-ai.exe --help
minions-ai.exe validate --agentDefinition "C:\path\to\examples\manager.agent.json"
minions-ai.exe list --db .\smoke.db
minions-ai.exe serve --port 3110 --db .\smoke.db
```

Then check `/api/status`, `/openapi.json`, `/docs`, `/docs/static/swagger-ui.css`, `/` and a cockpit JS asset. `ui --no-open` should behave the same as `serve` plus the cockpit URL.

On macOS the executable lives inside the bundle: `Minions-ai.app/Contents/MacOS/minions-ai`. On Linux, extract the tarball first; the binary is `minions-ai-linux-x64/minions-ai`.

For an end-to-end model run, set `MIMO_API_KEY` in the environment and use the xiaomi preset:

```bash
minions-ai.exe init --provider xiaomi --model mimo-v2.6-flash --api-key-env MIMO_API_KEY
minions-ai.exe run --agentDefinition examples/full-stack-developer.agent.json \
  --task "Reply with exactly: OK" --approval autopilot --no-stream --output-format json
```

Never put provider keys or GitHub tokens in a workflow file, a remote URL, a committed `.env`, or a screenshot. The `MIMO_API_KEY` name is safe to document; its value is not.

## Migration from a source/`./data` install

Packaged builds use the platform data directory instead of the current working directory. To keep an existing installation:

1. Close any running Minions-ai process.
2. Copy the old `data/` directory (including `.master-key`, the SQLite database and backups) into the platform data directory from the table above.
3. Start the new executable with `ui` or `serve`.

`--db <path>` always wins, so you can keep a database anywhere. Do not run two processes against one SQLite file.

## Troubleshooting the build

| Symptom | Cause / fix |
| --- | --- |
| `Not more than one entry file/directory is expected` | The pkg config asset glob resolved from the wrong directory. The build script includes both `build/exe/assets/**/*` and `assets/**/*`; keep both. |
| `packaged assets missing for native` | The asset ZIPs were not embedded. Check `assets` in `build/exe/pkg.config.json` and confirm the binary contains `assets-native.zip`. |
| `Cannot find module ... better_sqlite3.node` | The extracted native path was not applied. Confirm `isPackaged()` is true and the cache contains `assets/native/better_sqlite3.node`. |
| `import.meta.url` error at startup | The CJS bundle must use `moduleDir`/`moduleFile`; do not call `fileURLToPath(import.meta.url)` at module load in code that is bundled to CJS. |
| Massive binary / slow first run | The Copilot runtime is about 100 MB and is extracted once. Exclude duplicate SDK/docs/type files from the `copilot` group if you change the staging filter. |
| macOS cannot open the app | Unsigned builds need Gatekeeper approval (right-click → Open, or `xattr -dr com.apple.quarantine Minions-ai.app`) or a signed/notarized release. |

## Known limits

- Bytecode is not encryption. A determined attacker can reverse it. The only complete protection is server-side execution, which this local-first product deliberately does not require.
- The executable is large (roughly 90–250 MB depending on compression and platform). That is the cost of embedding Node, the cockpit and the Copilot runtime.
- The model provider must be reachable from the machine running Minions-ai.
- Team runs execute on the local machine; there is no distributed scheduler.
