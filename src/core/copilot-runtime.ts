import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ensureAssets } from './embedded-assets.js';

/**
 * The SDK normally materialises its per-platform runtime itself by resolving the
 * @github/copilot-sdk-<platform> package. In a packaged executable that package
 * is not resolvable as a module, so we extract it once and set COPILOT_CLI_PATH
 * to the native wrapper (the SDK honors that variable before its own lookup).
 */
export function ensureCopilotRuntime(): string | undefined {
  if (process.env.COPILOT_CLI_PATH) return process.env.COPILOT_CLI_PATH;
  try {
    const root = ensureAssets('copilot');
    const wrapper = join(
      root,
      'prebuilds',
      `${process.platform}-${process.arch}`,
      process.platform === 'win32' ? 'copilot-runtime.exe' : 'copilot-runtime',
    );
    if (existsSync(wrapper)) {
      process.env.COPILOT_CLI_PATH = wrapper;
      return wrapper;
    }
  } catch {
    // Development or an external Copilot CLI: let the SDK resolve its default.
  }
  return undefined;
}
