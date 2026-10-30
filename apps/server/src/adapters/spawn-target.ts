import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Windows cannot spawn .cmd/.bat shims without a shell (Node refuses with EINVAL), and we never use
 * shell:true. For npm shims we read the shim, find the real target it launches and spawn that directly.
 * Anything else (or any other platform) is spawned as given.
 */
/**
 * The node that runs a shim's .js target. In browser mode that is the server's own node. Inside the desktop app
 * the server runs on the app's executable, a windowed program with no console: a script run on it would start
 * every console tool it launches (codex.exe app-server, …) in a new, visible terminal. So there the user's own
 * node.exe from PATH runs scripts; the app itself only when there is none.
 */
export function scriptRunner(env: { electron: boolean; path: string; exists: (p: string) => boolean; execPath: string } = {
  electron: !!process.versions.electron, path: process.env.PATH ?? process.env.Path ?? '', exists: existsSync, execPath: process.execPath,
}): string {
  if (!env.electron) return env.execPath;
  for (const dir of env.path.split(';')) {
    if (!dir.trim()) continue;
    const node = path.win32.join(dir.trim(), 'node.exe');
    if (env.exists(node)) return node;
  }
  return env.execPath;
}

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
  return { command: scriptRunner(), args: [abs] };
}
