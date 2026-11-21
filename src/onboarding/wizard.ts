/**
 * Beginner setup wizard for `minions-ai init`.
 *
 * Step 0 lets the user choose HOW to set up — terminal wizard or the browser
 * wizard (the cockpit's first-run flow) — then walks them through provider
 * setup with plain-language explanations and prints a checklist summary.
 * The non-interactive contract (`--json`, `--api-key-stdin`, `--provider`, …)
 * is unchanged: flags skip the wizard entirely.
 */
import { createInterface } from 'node:readline/promises';
import { runInit, type InitOptions, type InitResult } from './init.js';

export type WizardOutcome = InitResult | 'browser' | 'flags';

const step = (n: number, title: string): void => {
  process.stderr.write(`\n\x1b[1m[step ${n}]\x1b[0m ${title}\n`);
};

/** Explains what each non-interactive flag does (the "Show flags" wizard path). */
export function printNonInteractiveFlags(): void {
  process.stderr.write(`
Non-interactive setup (CI, scripts, containers):

  minions-ai init --provider xiaomi --model mimo-v2.6-flash --api-key-stdin
  minions-ai init --provider openai --base-url https://api.openai.com/v1 \\
    --model gpt-4.1 --api-key-env OPENAI_API_KEY
  minions-ai init --provider custom --base-url http://localhost:11434/v1 \\
    --model llama3.2 --skip-test

Flags:
  --provider <id>        xiaomi | openai | anthropic | ollama | custom
  --name <display>       provider display name
  --base-url <url>       OpenAI-compatible /v1 base URL
  --model <id>           default model
  --api-key-stdin        read the API key from stdin (never on argv)
  --api-key-env <NAME>   read the API key from an environment variable
  --skip-test            do not probe the provider's /models endpoint
  --no-seed-agents       do not register the shipped role agents and sample team
  --json                 machine-readable output
`);
}

export async function runSetupWizard(opts: InitOptions): Promise<WizardOutcome> {
  const interactive = opts.interactive ?? Boolean(process.stdin.isTTY);
  const flagged = Boolean(opts.provider || opts.baseUrl || opts.model || opts.apiKey);
  if (!interactive || flagged) return runInit(opts);

  process.stderr.write(`
\x1b[1mMinions Cockpit — first-run setup\x1b[0m

This wizard configures your model provider (BYOK), seals the key in the local
encrypted vault, and registers the shipped role agents and the Software
Delivery Team so everything is runnable immediately.
`);
  process.stderr.write(`How would you like to set up?
  1. Terminal wizard (recommended on servers and containers)
  2. Browser setup (recommended on a desktop — full guided UI)
  3. Show non-interactive flags (for CI)
`);
  const io = createInterface({ input: process.stdin, output: process.stderr });
  let choice = '1';
  try { choice = (await io.question('Choose [1-3] (default 1): ')).trim() || '1'; } finally { io.close(); }

  if (choice === '2') {
    process.stderr.write(`
Opening the browser setup is a two-step handoff:

  1. Start the cockpit:      minions-ai ui
  2. Open the printed URL    (http://127.0.0.1:3100 by default)

The first screen is the setup wizard — it tests the connection before saving
and finishes by seeding the role agents and the sample team.
`);
    return 'browser';
  }
  if (choice === '3') { printNonInteractiveFlags(); return 'flags'; }

  step(1, 'Model provider');
  process.stderr.write('You need one OpenAI-compatible (or Anthropic/Azure) endpoint and an API key.\nPick the preset closest to your provider — you can edit every value afterwards.\n');
  const result = await runInit(opts);

  step(2, 'What was set up');
  process.stderr.write(`  ✓ provider   ${result.providerName} (${result.baseUrl})
  ✓ model      ${result.model}${result.tested ? `  · connection verified, ${result.models.length} models discovered` : '  · connection not tested'}
  ✓ key        sealed in the encrypted vault (never printed)
  ✓ agents     ${result.seededAgents.length ? result.seededAgents.join(', ') : 'none (skipped)'}
  ✓ teams      ${result.seededTeams.length ? result.seededTeams.map((t) => `${t.id}@${t.version}`).join(', ') : 'none (skipped)'}

Next:
  minions-ai ui                 → open the cockpit and start chatting
  minions-ai team list          → see the sample delivery team
`);
  return result;
}
