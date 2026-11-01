import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Chat, HistoryChat, ProviderId, TrashEntry } from '@agent-kanban/shared';
import { findRollout } from './history/codex.ts';

const DAY = 86_400_000;
export const TRASH_DAYS = 30;

export interface TrashPath { original: string; trashed: string }
interface TrashMeta extends Omit<TrashEntry, 'daysLeft'> { paths: TrashPath[]; codexIndexLines?: string[] }

export class TrashError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

async function move(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  try { await rename(from, to); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await cp(from, to, { recursive: true });
    await rm(from, { recursive: true });
  }
}

async function findClaudePaths(home: string, ref: string): Promise<string[]> {
  const root = join(home, '.claude', 'projects');
  const out: string[] = [];
  let projects;
  try { projects = await readdir(root, { withFileTypes: true }); } catch { return out; }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const dir = join(root, project.name);
    for (const name of [`${ref}.jsonl`, ref]) {
      const path = join(dir, name);
      if (await exists(path)) out.push(path);
    }
  }
  return out;
}

export class TrashService {
  private root: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private opts: { dataDir: string; home: string; now?: () => Date };

  constructor(opts: { dataDir: string; home: string; now?: () => Date }) {
    this.opts = opts;
    this.root = join(opts.dataDir, 'trash');
  }

  private now(): Date { return this.opts.now?.() ?? new Date(); }

  start(): void {
    void this.purge();
    this.timer = setInterval(() => void this.purge(), DAY);
    this.timer.unref?.();
  }

  dispose(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async deleteChat(chat: Chat): Promise<TrashEntry> {
    if (chat.column === 'running') throw new TrashError(409, 'Stop it first.');
    if (chat.provider === 'antigravity') throw new TrashError(422, "Antigravity chats can't be deleted from here yet.");
    if (!chat.sessionRef) throw new TrashError(409, "This chat hasn't started yet.");
    return this.delete({ provider: chat.provider, sessionRef: chat.sessionRef, title: chat.title, cwd: chat.cwd, updatedAt: chat.updatedAt }, chat.id);
  }

  async deleteHistory(chat: HistoryChat): Promise<TrashEntry> {
    if (chat.provider === 'antigravity') throw new TrashError(422, "Antigravity chats can't be deleted from here yet.");
    return this.delete(chat, null);
  }

  private async delete(chat: HistoryChat, chatId: string | null): Promise<TrashEntry> {
    const id = `${chat.provider}-${chat.sessionRef}`.replace(/[^a-zA-Z0-9._-]/g, '_');
    const dir = join(this.root, id);
    if (await exists(dir)) throw new TrashError(409, 'That chat is already in Trash.');
    await mkdir(dir, { recursive: true });
    const paths: TrashPath[] = [];
    let codexIndexLines: string[] | undefined;
    try {
      const originals = chat.provider === 'claude'
        ? await findClaudePaths(this.opts.home, chat.sessionRef)
        : [await findRollout(join(this.opts.home, '.codex'), chat.sessionRef)].filter((p): p is string => Boolean(p));
      for (const original of originals) {
        const trashed = join(dir, 'files', `${paths.length}-${basename(original)}`);
        await move(original, trashed);
        paths.push({ original, trashed });
      }
      if (chat.provider === 'codex') {
        const index = join(this.opts.home, '.codex', 'session_index.jsonl');
        if (await exists(index)) {
          const text = await readFile(index, 'utf8');
          const lines = text.split(/\r?\n/).filter(Boolean);
          codexIndexLines = lines.filter((line) => {
            try { return (JSON.parse(line) as { id?: unknown }).id === chat.sessionRef; } catch { return false; }
          });
          const kept = lines.filter((line) => !codexIndexLines!.includes(line));
          await writeFile(index, kept.length ? `${kept.join('\n')}\n` : '', 'utf8');
        }
      }
      const meta: TrashMeta = { id, chatId, provider: chat.provider, sessionRef: chat.sessionRef, title: chat.title, deletedAt: this.now().toISOString(), paths, ...(codexIndexLines?.length ? { codexIndexLines } : {}) };
      await writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
      return this.entry(meta);
    } catch (err) {
      for (const p of paths.reverse()) if (await exists(p.trashed)) await move(p.trashed, p.original).catch(() => {});
      await rm(dir, { recursive: true, force: true });
      throw err;
    }
  }

  async list(): Promise<TrashEntry[]> {
    let dirs;
    try { dirs = await readdir(this.root, { withFileTypes: true }); } catch { return []; }
    const out: TrashEntry[] = [];
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      try { out.push(this.entry(JSON.parse(await readFile(join(this.root, dir.name, 'meta.json'), 'utf8')) as TrashMeta)); } catch { /* incomplete entry: ignored */ }
    }
    return out.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  }

  async restore(id: string): Promise<TrashEntry> {
    const dir = join(this.root, id);
    let meta: TrashMeta;
    try { meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as TrashMeta; } catch { throw new TrashError(404, 'Trash item not found.'); }
    for (const path of meta.paths) if (await exists(path.original)) throw new TrashError(409, `Can't restore because ${path.original} already exists.`);
    for (const path of meta.paths) await move(path.trashed, path.original);
    if (meta.provider === 'codex' && meta.codexIndexLines?.length) {
      const index = join(this.opts.home, '.codex', 'session_index.jsonl');
      await mkdir(dirname(index), { recursive: true });
      const current = await readFile(index, 'utf8').catch(() => '');
      const prefix = current && !current.endsWith('\n') ? `${current}\n` : current;
      await writeFile(index, `${prefix}${meta.codexIndexLines.join('\n')}\n`, 'utf8');
    }
    const entry = this.entry(meta);
    await rm(dir, { recursive: true, force: true });
    return entry;
  }

  async empty(): Promise<void> { await rm(this.root, { recursive: true, force: true }); }

  async purge(): Promise<number> {
    const cutoff = this.now().getTime() - TRASH_DAYS * DAY;
    const entries = await this.list();
    const old = entries.filter((e) => Date.parse(e.deletedAt) <= cutoff);
    await Promise.all(old.map((e) => rm(join(this.root, e.id), { recursive: true, force: true })));
    return old.length;
  }

  private entry(meta: TrashMeta): TrashEntry & { paths: TrashPath[]; codexIndexLines?: string[] } {
    const age = Math.max(0, this.now().getTime() - Date.parse(meta.deletedAt));
    return { ...meta, daysLeft: Math.max(0, TRASH_DAYS - Math.floor(age / DAY)) };
  }
}
