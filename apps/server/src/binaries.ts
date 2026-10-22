import { execFile } from 'node:child_process';

/** Locate the official CLI on PATH. Windows: prefer a real .exe, else a .cmd shim (the adapters resolve shims themselves). */
export function findBinary(name: 'claude' | 'codex'): Promise<string | null> {
  const win = process.platform === 'win32';
  return new Promise((resolve) => {
    execFile(win ? 'where.exe' : 'which', [name], { windowsHide: true, timeout: 10_000 }, (err, stdout) => {
      if (err) return resolve(null);
      const lines = String(stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (!win) return resolve(lines[0] ?? null);
      const lower = (l: string) => l.toLowerCase();
      resolve(lines.find((l) => lower(l).endsWith('.exe')) ?? lines.find((l) => lower(l).endsWith('.cmd')) ?? null);
    });
  });
}
