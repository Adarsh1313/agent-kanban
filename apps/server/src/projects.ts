import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Chat, Column, HistoryChat, Project, ProjectInfo, ProviderId } from '@agent-kanban/shared';
import { folderKey } from '@agent-kanban/shared';

const COLUMNS: Column[] = ['running', 'needs_you', 'review', 'done'];

/** Group chats on the board and history-only chats by folder. Newest activity first. */
export function buildProjects(chats: Chat[], history: HistoryChat[]): Project[] {
  const map = new Map<string, Project & { models: Map<ProviderId, { at: string; model: string }> }>();
  const get = (cwd: string) => {
    const k = folderKey(cwd);
    let p = map.get(k);
    if (!p) {
      p = { id: cwd, name: basename(cwd) || cwd, path: cwd, providers: [], columns: { running: 0, needs_you: 0, review: 0, done: 0 }, historyOnly: 0, lastActivityAt: '', models: new Map() };
      map.set(k, p);
    }
    return p;
  };
  const touch = (p: Project, provider: ProviderId, at: string, isChat: boolean) => {
    let e = p.providers.find((x) => x.provider === provider);
    if (!e) { e = { provider, chats: 0, lastUsedAt: '', lastModel: null }; p.providers.push(e); }
    if (isChat) e.chats++;
    if (at > e.lastUsedAt) e.lastUsedAt = at;
    if (at > p.lastActivityAt) p.lastActivityAt = at;
    return e;
  };
  const known = new Set<string>();
  for (const c of chats) {
    if (c.archived) continue;
    const p = get(c.cwd);
    touch(p, c.provider, c.updatedAt, true);
    if (c.column) p.columns[c.column]++;
    if (c.sessionRef) known.add(`${c.provider}:${c.sessionRef}`);
    if (c.model) {
      const cur = p.models.get(c.provider);
      if (!cur || c.updatedAt > cur.at) p.models.set(c.provider, { at: c.updatedAt, model: c.model });
    }
  }
  for (const h of history) {
    if (known.has(`${h.provider}:${h.sessionRef}`)) continue;
    const p = get(h.cwd);
    touch(p, h.provider, h.updatedAt, false);
    p.historyOnly++;
  }
  const out: Project[] = [];
  for (const { models, ...p } of map.values()) {
    for (const e of p.providers) e.lastModel = models.get(e.provider)?.model ?? null;
    p.providers.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
    out.push(p);
  }
  return out.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
}

const DEP_STACK: [string, string][] = [
  ['react', 'React'], ['next', 'Next.js'], ['vite', 'Vite'], ['vue', 'Vue'], ['svelte', 'Svelte'], ['express', 'Express'], ['typescript', 'TypeScript'],
];

function detectStack(path: string): string[] {
  const stack: string[] = [];
  try {
    const pkg = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')) as Record<string, unknown>;
    const deps = { ...(pkg.dependencies as object | undefined), ...(pkg.devDependencies as object | undefined) } as Record<string, unknown>;
    for (const [dep, label] of DEP_STACK) if (dep in deps) stack.push(label);
  } catch { /* no or unreadable package.json */ }
  const has = (f: string) => existsSync(join(path, f));
  if (has('pyproject.toml') || has('requirements.txt')) stack.push('Python');
  if (has('go.mod')) stack.push('Go');
  if (has('Cargo.toml')) stack.push('Rust');
  return stack;
}

function git(path: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['-C', path, ...args], { timeout: 10_000, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
  });
}

/** Read-only look at a folder: stack, git, instruction files, top-level folders. */
export async function projectInfo(path: string): Promise<ProjectInfo> {
  const has = (f: string) => existsSync(join(path, f));
  let topFolders: string[] = [];
  try {
    topFolders = readdirSync(path, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b));
  } catch { /* unreadable */ }
  let gitInfo: ProjectInfo['git'] = null;
  const branch = await git(path, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch) {
    const log = await git(path, ['log', '-1', '--format=%s%x00%cI']);
    const [lastCommit, lastCommitAt] = (log ?? '').split('\0');
    gitInfo = { branch, lastCommit: lastCommit ?? '', lastCommitAt: lastCommitAt ?? '' };
  }
  return {
    stack: detectStack(path),
    git: gitInfo,
    instructionFiles: { claude: has('CLAUDE.md'), codex: has('AGENTS.md'), antigravity: has('GEMINI.md') },
    topFolders,
  };
}
