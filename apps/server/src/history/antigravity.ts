import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { HistoryChat } from '@agent-kanban/shared';

function toIso(v: unknown): string {
  const d = new Date(typeof v === 'string' ? v.replace(' ', 'T') : NaN);
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

function firstCwd(uris: unknown): string {
  try {
    const arr = JSON.parse(String(uris)) as unknown;
    if (Array.isArray(arr) && typeof arr[0] === 'string') return fileURLToPath(arr[0]);
  } catch { /* bad row */ }
  return '';
}

export async function readAntigravityHistory(dbPath: string): Promise<HistoryChat[]> {
  if (!existsSync(dbPath)) return [];
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare('SELECT conversation_id, title, workspace_uris, last_modified_time FROM conversation_summaries').all();
    const out: HistoryChat[] = [];
    for (const r of rows) {
      if (typeof r.conversation_id !== 'string') continue;
      out.push({
        provider: 'antigravity',
        sessionRef: r.conversation_id,
        title: typeof r.title === 'string' && r.title ? r.title : 'Untitled chat',
        cwd: firstCwd(r.workspace_uris),
        updatedAt: toIso(r.last_modified_time),
      });
    }
    return out;
  } catch { return []; } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}
