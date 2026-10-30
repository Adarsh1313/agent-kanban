import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import type { HistoryChat } from '@agent-kanban/shared';
import { readJsonl } from './jsonl.ts';

async function indexRollouts(dir: string, map: Map<string, string>): Promise<void> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await indexRollouts(p, map);
    else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl.zst')) {
      const m = /-([0-9a-fA-F-]{36})\.jsonl\.zst$/.exec(e.name);
      if (m) map.set(m[1], p);
    }
  }
}

/** The rollout file of one Codex thread, or null. */
export async function findRollout(codexHome: string, id: string): Promise<string | null> {
  const map = new Map<string, string>();
  await indexRollouts(join(codexHome, 'sessions'), map);
  return map.get(id) ?? null;
}

async function rolloutCwd(path: string): Promise<string> {
  try {
    const text = zstdDecompressSync(await readFile(path)).toString('utf8');
    const line = text.split('\n', 1)[0];
    const rec = JSON.parse(line) as { type?: string; payload?: { cwd?: unknown } };
    return rec.type === 'session_meta' && typeof rec.payload?.cwd === 'string' ? rec.payload.cwd : '';
  } catch { return ''; }
}

function toIso(v: unknown): string {
  const d = new Date(typeof v === 'string' ? v : NaN);
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

export async function readCodexHistory(codexHome: string): Promise<HistoryChat[]> {
  const rollouts = new Map<string, string>();
  await indexRollouts(join(codexHome, 'sessions'), rollouts);
  // Codex appends a new index line when a thread is renamed or updated: the last line for an id wins.
  const latest = new Map<string, Record<string, unknown>>();
  for await (const rec of readJsonl(join(codexHome, 'session_index.jsonl'))) {
    if (typeof rec.id !== 'string' || !rec.id) continue;
    latest.delete(rec.id);
    latest.set(rec.id, rec);
  }
  const out: HistoryChat[] = [];
  for (const [id, rec] of latest) {
    const path = rollouts.get(id);
    out.push({
      provider: 'codex',
      sessionRef: id,
      title: typeof rec.thread_name === 'string' && rec.thread_name ? rec.thread_name : 'Untitled chat',
      cwd: path ? await rolloutCwd(path) : '',
      updatedAt: toIso(rec.updated_at),
    });
  }
  return out;
}
