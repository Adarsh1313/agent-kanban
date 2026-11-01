import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Chat, HistoryChat, Project, ProjectInfo } from '@agent-kanban/shared';
import { buildProjects, projectInfo } from '../src/projects.ts';
import { createApi } from '../src/api.ts';

const chat = (o: Partial<Chat>): Chat => ({
  id: 'c', provider: 'claude', sessionRef: null, cwd: 'C:\\a', title: 't', model: null, column: 'running', needsReason: null,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', doneAt: null, archived: false, pinned: false, snoozedUntil: null, ...o,
});
const h = (o: Partial<HistoryChat>): HistoryChat => ({ provider: 'claude', sessionRef: 'h', title: 'h', cwd: 'C:\\b', updatedAt: '2026-01-05T00:00:00Z', ...o });

test('groups chats and history by folder, newest first', () => {
  const ps = buildProjects(
    [
      chat({ id: '1', provider: 'claude', model: 'opus', column: 'running', updatedAt: '2026-01-03T00:00:00Z' }),
      chat({ id: '2', provider: 'codex', model: 'gpt-5', column: 'done', updatedAt: '2026-01-02T00:00:00Z' }),
      chat({ id: '3', provider: 'claude', model: null, column: 'needs_you', updatedAt: '2026-01-04T00:00:00Z' }),
    ],
    [h({ cwd: 'C:\\b', updatedAt: '2026-01-06T00:00:00Z' })],
  );
  assert.deepEqual(ps.map((p) => p.id), ['C:\\b', 'C:\\a']);
  const [b, a] = ps as [Project, Project];
  assert.equal(b.name, 'b');
  assert.equal(b.historyOnly, 1);
  assert.deepEqual(b.columns, { running: 0, needs_you: 0, review: 0, done: 0 });
  assert.deepEqual(b.providers, [{ provider: 'claude', chats: 0, lastUsedAt: '2026-01-06T00:00:00Z', lastModel: null }]);
  assert.equal(a.historyOnly, 0);
  assert.deepEqual(a.columns, { running: 1, needs_you: 1, review: 0, done: 1 });
  assert.equal(a.lastActivityAt, '2026-01-04T00:00:00Z');
  const claude = a.providers.find((p) => p.provider === 'claude')!;
  assert.equal(claude.chats, 2);
  assert.equal(claude.lastModel, 'opus'); // newest chat that has a model
  assert.equal(a.providers.find((p) => p.provider === 'codex')!.lastModel, 'gpt-5');
});

test('a history entry for a chat already on the board is not counted twice', () => {
  const ps = buildProjects([chat({ sessionRef: 's1' })], [h({ cwd: 'C:\\a', sessionRef: 's1' })]);
  assert.equal(ps.length, 1);
  assert.equal(ps[0]!.historyOnly, 0);
  assert.equal(ps[0]!.providers[0]!.chats, 1);
});

test('projectInfo reads stack, instruction files and top folders; no git gives null', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ak-proj-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { react: '1' }, devDependencies: { vite: '1' } }));
  writeFileSync(join(dir, 'CLAUDE.md'), '# hi');
  for (const d of ['src', 'docs', '.hidden', 'node_modules']) mkdirSync(join(dir, d));
  writeFileSync(join(dir, 'file.txt'), 'x');
  const info = await projectInfo(dir);
  assert.deepEqual(info.stack, ['React', 'Vite']);
  assert.deepEqual(info.instructionFiles, { claude: true, codex: false, antigravity: false });
  assert.deepEqual(info.topFolders, ['docs', 'src']);
  assert.equal(info.git, null);
});

test('projectInfo reads git branch and last commit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ak-git-'));
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'pyproject.toml'), '');
  git('add', '.');
  git('commit', '-q', '-m', 'first thing');
  const info = await projectInfo(dir);
  assert.equal(info.git?.branch, 'main');
  assert.equal(info.git?.lastCommit, 'first thing');
  assert.match(info.git?.lastCommitAt ?? '', /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(info.stack, ['Python']);
});

test('GET /api/projects and /api/projects/info (known paths only)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ak-pi-'));
  writeFileSync(join(dir, 'go.mod'), 'module x');
  const chats: any = { listChats: () => [chat({ cwd: dir })] };
  const api = createApi({ chats, usage: {} as any, history: async () => [], token: 'tok' });
  await new Promise<void>((r) => api.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  const f = (p: string, token = 'tok') => fetch(base + p, { headers: { Authorization: `Bearer ${token}` } });
  try {
    const list = (await (await f('/api/projects')).json()) as Project[];
    assert.equal(list[0]!.id, dir);
    const ok = await f('/api/projects/info?path=' + encodeURIComponent(dir));
    assert.equal(ok.status, 200);
    assert.deepEqual(((await ok.json()) as ProjectInfo).stack, ['Go']);
    // Another spelling of the same folder (trailing separator; on Windows also other case and forward slashes).
    const other = process.platform === 'win32' ? dir.toUpperCase().replaceAll('\\', '/') + '/' : dir + '/';
    const alias = await f('/api/projects/info?path=' + encodeURIComponent(other));
    assert.equal(alias.status, 200);
    assert.deepEqual(((await alias.json()) as ProjectInfo).stack, ['Go']);
    const no = await f('/api/projects/info?path=' + encodeURIComponent(tmpdir()));
    assert.equal(no.status, 404);
    assert.deepEqual(await no.json(), { error: 'Not found.' });
    assert.equal((await f('/api/projects/info')).status, 404);
    assert.equal((await f('/api/projects', 'bad')).status, 401);
  } finally { api.close(); api.server.closeAllConnections(); api.server.close(); }
});

test('one project per folder however it is spelled (drive case, trailing separator, slashes)', () => {
  const ps = buildProjects(
    [chat({ id: '1', cwd: 'C:\\a' }), chat({ id: '2', cwd: 'c:\\a\\' })],
    [h({ sessionRef: 'x', cwd: 'C:/a' })],
  );
  assert.equal(ps.length, 1);
  assert.equal(ps[0]!.providers[0]!.chats, 2);
  assert.equal(ps[0]!.historyOnly, 1);
});

test('Move to project: PATCH projectLabel regroups the chat; cwd is kept', async () => {
  const { Store } = await import('../src/store.ts');
  const { ChatService } = await import('../src/chats.ts');
  const { createApi } = await import('../src/api.ts');
  const store = new Store(':memory:');
  const svc = new ChatService({ store, adapters: {}, usage: { refresh: async () => [] } as any, broadcast: () => {}, claudeHome: '/nowhere' });
  const chat = store.createChat({ provider: 'claude', cwd: '/w/one', title: 't' });
  store.createChat({ provider: 'claude', cwd: '/w/two', title: 'u' });
  const api = createApi({ chats: svc, usage: { latest: () => [] } as any, history: async () => [], token: 'tok' });
  await new Promise<void>((r) => api.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(api.server.address() as import('node:net').AddressInfo).port}`;
  const f = (m: string, p: string, b?: unknown) => fetch(base + p, { method: m, headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  try {
    const moved = (await (await f('PATCH', `/api/chats/${chat.id}`, { projectLabel: '/w/two' })).json()) as any;
    assert.equal(moved.cwd, '/w/one');
    assert.equal(moved.projectLabel, '/w/two');
    const projects = (await (await f('GET', '/api/projects')).json()) as any[];
    assert.deepEqual(projects.map((p) => [p.path, p.providers[0].chats]), [['/w/two', 2]]);
    assert.equal((await f('PATCH', `/api/chats/${chat.id}`, { projectLabel: 5 })).status, 400);
  } finally {
    api.close(); api.server.closeAllConnections(); api.server.close();
  }
});
