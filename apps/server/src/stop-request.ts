import { existsSync, rmSync } from 'node:fs';

/**
 * The desktop "Stop Agent Kanban" shortcut asks the running server to shut down by creating this file in the
 * data folder. A file (rather than a kill) lets the server close every provider process cleanly, and needs no
 * token: anything that can write to the user's data folder is already trusted.
 */
export const STOP_REQUEST_FILE = 'stop.request';

/** Clears a stale request, then checks every intervalMs; the first request found is removed and onStop runs once. */
export function watchStopRequest(path: string, onStop: () => void, intervalMs = 1_000): () => void {
  rmSync(path, { force: true });
  let fired = false;
  const timer = setInterval(() => {
    if (fired || !existsSync(path)) return;
    fired = true;
    rmSync(path, { force: true });
    clearInterval(timer);
    onStop();
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
