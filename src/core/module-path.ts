import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve a module directory in both ESM (dev/tsx) and the CJS bundle used by
 * the packaged executable. esbuild cannot expose import.meta.url in CJS output,
 * so __dirname is the fallback.
 */
export function moduleDir(metaUrl: string | undefined): string {
  if (metaUrl) return dirname(fileURLToPath(metaUrl));
  return typeof __dirname === 'string' ? __dirname : process.cwd();
}

export function moduleFile(metaUrl: string | undefined): string {
  if (metaUrl) return fileURLToPath(metaUrl);
  return typeof __filename === 'string' ? __filename : process.argv[1] ?? '';
}
