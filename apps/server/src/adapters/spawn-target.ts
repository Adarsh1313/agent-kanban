import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Windows cannot spawn .cmd/.bat shims without a shell (Node refuses with EINVAL), and we never use
 * shell:true. For npm shims we read the shim, find the real target it launches and spawn that directly.
 * Anything else (or any other platform) is spawned as given.
 */
export function resolveSpawnTarget(file: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  const plain = { command: file, args: [] as string[] };
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(file)) return plain;
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return plain; }
  // Quoted "%dp0%\relative\target" entries; skip the bundled node.exe probe that npm shims contain.
  const targets = [...text.matchAll(/"%dp0%\\([^"]+\.(?:js|cjs|mjs|exe))"/gi)]
    .map((m) => m[1]!)
    .filter((rel) => path.win32.basename(rel).toLowerCase() !== 'node.exe');
  const rel = targets[targets.length - 1];
  if (!rel) return plain;
  const abs = path.win32.join(path.win32.dirname(file), rel);
  if (/\.exe$/i.test(abs)) return { command: abs, args: [] };
  return { command: process.execPath, args: [abs] };
}
