import type { ToolCall, UsageReading } from '@agent-kanban/shared';
import type { IconName } from '../primitives/index.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Card time, as the design writes it: "now", "2m", "1h", "Yesterday", "3d", "1w". */
export function relativeTime(iso: string, now: number): string {
  const d = now - Date.parse(iso);
  if (!(d >= MIN)) return 'now';
  if (d < HOUR) return `${Math.floor(d / MIN)}m`;
  if (d < DAY) return `${Math.floor(d / HOUR)}h`;
  if (d < 2 * DAY) return 'Yesterday';
  if (d < 7 * DAY) return `${Math.floor(d / DAY)}d`;
  return `${Math.floor(d / (7 * DAY))}w`;
}

/** How long a chat took: "45s", "6m", "1h 20m". */
export function duration(ms: number): string {
  if (!(ms > 0)) return '0s';
  if (ms < MIN) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < HOUR) return `${Math.round(ms / MIN)}m`;
  const h = Math.floor(ms / HOUR);
  const m = Math.round((ms % HOUR) / MIN);
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** "2:40 pm" (today) or "Mon 2:40 pm". */
export function clockTime(iso: string, now: number): string {
  const d = new Date(iso);
  const t = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase();
  if (d.toDateString() === new Date(now).toDateString()) return t;
  return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${t}`;
}

/** The next reset of an exhausted usage window (or of any window when none reads 0% left). */
export function limitResetsAt(reading: UsageReading | undefined, now: number): string | null {
  if (!reading) return null;
  const future = reading.windows.filter((w) => w.resetsAt && Date.parse(w.resetsAt) > now);
  const pool = future.some((w) => w.leftPct <= 0) ? future.filter((w) => w.leftPct <= 0) : future;
  const first = pool.map((w) => w.resetsAt!).sort()[0];
  return first ?? null;
}

/** The step the activity line names: the latest running tool call, else the latest one. */
export function currentCall(calls: ToolCall[] | undefined): ToolCall | null {
  if (!calls || calls.length === 0) return null;
  for (let i = calls.length - 1; i >= 0; i--) if (calls[i]!.status === 'running') return calls[i]!;
  return calls[calls.length - 1]!;
}

/** An icon for a tool call, from its tool name (Read, Edit, Bash, Grep, WebFetch…). */
export function toolIcon(name: string): IconName {
  const n = name.toLowerCase();
  if (/read|view|open|cat/.test(n)) return 'eye';
  if (/edit|write|patch|apply|create|replace/.test(n)) return 'edit';
  if (/grep|glob|search|find|list|ls/.test(n)) return 'search2';
  if (/web|fetch|browse|url/.test(n)) return 'globe';
  return 'terminal';
}
