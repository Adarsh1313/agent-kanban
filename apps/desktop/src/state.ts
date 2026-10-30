// The desktop app's own small state (window placement, whether the first-close note was shown), kept in
// the data folder next to the server's database. Unreadable or missing means "first launch".
import { readFileSync, writeFileSync } from 'node:fs';
import type { Placement } from './placement.ts';

export interface DesktopState {
  placement: Placement | null;
  closeNoted: boolean;
}

export function loadState(path: string): DesktopState {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<DesktopState>;
    return { placement: raw.placement ?? null, closeNoted: raw.closeNoted === true };
  } catch {
    return { placement: null, closeNoted: false };
  }
}

/** True the first time the window is ever closed (show the "still running" note), false after that. */
export function noteFirstClose(state: DesktopState): boolean {
  if (state.closeNoted) return false;
  state.closeNoted = true;
  return true;
}

export function saveState(path: string, state: DesktopState): void {
  try { writeFileSync(path, JSON.stringify(state)); } catch { /* not worth interrupting anyone over */ }
}
