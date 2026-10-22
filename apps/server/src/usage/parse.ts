// Ported from pingdotgg/t3code (MIT), apps/server/src/provider/claudeUsageLimits.ts and codexUsageLimits.ts
import type { ProviderId, UsageReading, UsageWindow } from '@agent-kanban/shared';

export interface CodexWindow { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null }
export interface CodexSnapshot { limitId: string | null; limitName: string | null; primary: CodexWindow | null; secondary: CodexWindow | null }

type ClaudeLimit = { utilization: number | null; resets_at: string | null } | null | undefined;
interface ClaudeUsage { rate_limits_available: boolean; rate_limits: null | Record<string, ClaudeLimit> }
interface CodexLimits { rateLimits: CodexSnapshot; rateLimitsByLimitId?: Record<string, CodexSnapshot> | null }

const left = (usedPct: number): number => Math.min(100, Math.max(0, Math.round(100 - usedPct)));

const CLAUDE_KEYS: Record<string, { kind: UsageWindow['kind']; label: string }> = {
  five_hour: { kind: 'five_hour', label: '5-hour' },
  seven_day: { kind: 'weekly', label: 'Weekly' },
  seven_day_opus: { kind: 'model', label: 'Opus · weekly' },
  seven_day_sonnet: { kind: 'model', label: 'Sonnet · weekly' },
};

export function claudeUsageToReading(r: ClaudeUsage, now: Date): UsageReading {
  const base = { provider: 'claude' as const, readAt: now.toISOString() };
  if (!r.rate_limits_available) return { ...base, status: 'unavailable', windows: [] };
  const windows: UsageWindow[] = [];
  for (const [key, meta] of Object.entries(CLAUDE_KEYS)) {
    const lim = r.rate_limits?.[key];
    if (!lim || typeof lim.utilization !== 'number') continue;
    windows.push({ kind: meta.kind, label: meta.label, leftPct: left(lim.utilization), resetsAt: lim.resets_at ?? null });
  }
  return { ...base, status: 'ok', windows };
}

function codexWindow(w: CodexWindow, label?: string): UsageWindow | null {
  const mins = w.windowDurationMins;
  let kind: UsageWindow['kind'];
  let name: string;
  if (label !== undefined) { kind = 'model'; name = label; }
  else if (mins === null || mins === undefined) return null;
  else if (mins <= 300) { kind = 'five_hour'; name = '5-hour'; }
  else if (mins >= 10080) { kind = 'weekly'; name = 'Weekly'; }
  else return null;
  return {
    kind, label: name, leftPct: left(w.usedPercent),
    resetsAt: w.resetsAt === null || w.resetsAt === undefined ? null : new Date(w.resetsAt * 1000).toISOString(),
  };
}

export function codexLimitsToReading(r: CodexLimits, now: Date): UsageReading {
  const windows: UsageWindow[] = [];
  for (const w of [r.rateLimits.primary, r.rateLimits.secondary]) {
    const win = w && codexWindow(w);
    if (win) windows.push(win);
  }
  for (const [id, snap] of Object.entries(r.rateLimitsByLimitId ?? {})) {
    if (id === 'codex') continue;
    const label = snap.limitName ?? id;
    for (const w of [snap.primary, snap.secondary]) {
      const win = w && codexWindow(w, label);
      if (win) windows.push(win);
    }
  }
  return { provider: 'codex', status: 'ok', windows, readAt: now.toISOString() };
}

export function suggest(readings: UsageReading[], allowed: ProviderId[]): ProviderId | null {
  let best: { provider: ProviderId; score: number; reset: number } | null = null;
  for (const rd of readings) {
    if (!allowed.includes(rd.provider) || rd.status !== 'ok') continue;
    const main = rd.windows.filter((w) => w.kind === 'five_hour' || w.kind === 'weekly');
    if (main.length === 0) continue;
    const score = Math.min(...main.map((w) => w.leftPct));
    const fh = rd.windows.find((w) => w.kind === 'five_hour')?.resetsAt;
    const reset = fh ? Date.parse(fh) : Infinity;
    if (!best || score > best.score || (score === best.score && reset < best.reset)) best = { provider: rd.provider, score, reset };
  }
  return best ? best.provider : null;
}
