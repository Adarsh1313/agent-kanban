import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { HistoryChat } from '@agent-kanban/shared';
import { readJsonl } from './jsonl.ts';

function userText(rec: Record<string, unknown>): string {
  const msg = rec.message as { content?: unknown } | undefined;
  const c = msg?.content;
  if (typeof c === 'string') return c.trim();
  if (Array.isArray(c)) {
    for (const b of c) {
      const blk = b as { type?: string; text?: unknown };
      if (blk?.type === 'text' && typeof blk.text === 'string' && blk.text.trim()) return blk.text.trim();
    }
  }
  return '';
}

async function readSession(path: string, sessionRef: string): Promise<HistoryChat | null> {
  try {
    const mtime = (await stat(path)).mtime.toISOString();
    let custom = '';
    let firstPrompt = '';
    let cwd = '';
    let first = true;
    for await (const rec of readJsonl(path)) {
      if (first) { cwd = typeof rec.cwd === 'string' ? rec.cwd : ''; first = false; }
      if (!cwd && typeof rec.cwd === 'string') cwd = rec.cwd;
      if (rec.type === 'custom-title' && typeof rec.customTitle === 'string' && rec.customTitle) custom = rec.customTitle;
      else if (rec.type === 'user' && !firstPrompt) firstPrompt = userText(rec);
    }
    const title = custom || (firstPrompt ? firstPrompt.slice(0, 60) : 'Untitled chat');
    return { provider: 'claude', sessionRef, title, cwd, updatedAt: mtime };
  } catch { return null; }
}

export async function readClaudeHistory(claudeHome: string): Promise<HistoryChat[]> {
  const root = join(claudeHome, 'projects');
  let dirs: string[];
  try { dirs = await readdir(root); } catch { return []; }
  const out: HistoryChat[] = [];
  for (const d of dirs) {
    let files: string[];
    try { files = await readdir(join(root, d)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const chat = await readSession(join(root, d, f), f.slice(0, -'.jsonl'.length));
      if (chat) out.push(chat);
    }
  }
  return out;
}
