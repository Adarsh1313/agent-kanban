import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';

/** True when a process with this pid exists (EPERM: it exists but belongs to someone else). */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Claims the single-instance lock file by writing our pid into it. Returns false when another live process
 * holds it. A lock left behind by a process that is gone (or a garbled file) is taken over.
 */
export function acquireLock(path: string, pid: number = process.pid, isAlive: (pid: number) => boolean = processAlive): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, String(pid), { flag: 'wx' });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    let holder = NaN;
    try { holder = Number.parseInt(readFileSync(path, 'utf8').trim(), 10); } catch { /* vanished or unreadable: retry */ }
    if (holder === pid) return true;
    if (Number.isInteger(holder) && isAlive(holder)) return false;
    try { unlinkSync(path); } catch { /* someone else removed it first */ }
  }
  return false;
}

/** Removes the lock file, but only if it is still ours. */
export function releaseLock(path: string, pid: number = process.pid): void {
  try {
    if (readFileSync(path, 'utf8').trim() === String(pid)) unlinkSync(path);
  } catch { /* already gone */ }
}
