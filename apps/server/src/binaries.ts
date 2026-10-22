import { execFile } from 'node:child_process';

/** Pick the launcher from `where.exe` / `which` output. Windows: first .exe, else first .cmd (an extensionless sh shim is skipped). */
export function pickBinary(output: string, win: boolean): string | null {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!win) return lines[0] ?? null;
  const lower = (l: string) => l.toLowerCase();
  return lines.find((l) => lower(l).endsWith('.exe')) ?? lines.find((l) => lower(l).endsWith('.cmd')) ?? null;
}

/** Locate the official CLI on PATH (the adapters resolve .cmd shims themselves). */
export function findBinary(name: 'claude' | 'codex'): Promise<string | null> {
  const win = process.platform === 'win32';
  return new Promise((resolve) => {
    execFile(win ? 'where.exe' : 'which', [name], { windowsHide: true, timeout: 10_000 }, (err, stdout) => {
      resolve(err ? null : pickBinary(String(stdout), win));
    });
  });
}
