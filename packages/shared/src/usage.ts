import type { ProviderId, UsageReading } from './types.ts';

/**
 * The provider with the most room: the highest of min(5-hour, weekly) left among `ok` readings of allowed providers;
 * ties go to the sooner 5-hour reset. Shared by the server (/api/usage) and the web app (usage.updated events).
 */
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
