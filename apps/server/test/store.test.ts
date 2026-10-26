import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';

const tick = () => new Promise((r) => setTimeout(r, 5));

test('createChat normalizes title and defaults', () => {
  const s = new Store(':memory:');
  const first = 'Line one that is quite long and goes on and on and on and on and on 70c';
  const c = s.createChat({ provider: 'claude', cwd: '/x', title: first + '\nsecond' });
  assert.equal(c.column, 'running');
  assert.equal(c.needsReason, null);
  assert.equal(c.archived, false);
  assert.equal(c.pinned, false);
  assert.equal(c.title, first.slice(0, 60));
  assert.equal(c.title.length, 60);
});

test('updateChat bumps updatedAt and persists across stores', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ak-')), 'a.db');
  const s = new Store(file);
  const c = s.createChat({ provider: 'codex', cwd: '/x', title: 't' });
  await tick();
  const u = s.updateChat(c.id, { column: 'review', pinned: true });
  assert.notEqual(u.updatedAt, c.updatedAt);
  const s2 = new Store(file);
  const got = s2.getChat(c.id);
  assert.equal(got?.column, 'review');
  assert.equal(got?.pinned, true);
});

test('listChats newest first, excludes archived', async () => {
  const s = new Store(':memory:');
  const a = s.createChat({ provider: 'claude', cwd: '/x', title: 'a' });
  await tick();
  const b = s.createChat({ provider: 'claude', cwd: '/x', title: 'b' });
  await tick();
  const c = s.createChat({ provider: 'claude', cwd: '/x', title: 'c' });
  await tick();
  const d = s.createChat({ provider: 'claude', cwd: '/x', title: 'd' });
  s.updateChat(d.id, { archived: true });
  assert.deepEqual(s.listChats().map((x) => x.id), [c.id, b.id, a.id]);
});

test('findBySessionRef', () => {
  const s = new Store(':memory:');
  const c = s.createChat({ provider: 'claude', cwd: '/x', title: 't' });
  s.updateChat(c.id, { sessionRef: 's1' });
  assert.equal(s.findBySessionRef('claude', 's1')?.id, c.id);
  assert.equal(s.findBySessionRef('codex', 's1'), undefined);
});

test('messages append', () => {
  const s = new Store(':memory:');
  const c = s.createChat({ provider: 'claude', cwd: '/x', title: 't' });
  const m = s.addMessage(c.id, 'assistant', 'He');
  s.appendToMessage(m.id, 'llo');
  s.appendToMessage(m.id, '!');
  const l = s.listMessages(c.id);
  assert.equal(l.length, 1);
  assert.equal(l[0].text, 'Hello!');
});

test('tool calls upsert', () => {
  const s = new Store(':memory:');
  const c = s.createChat({ provider: 'claude', cwd: '/x', title: 't' });
  s.upsertToolCall({ id: 'tc1', chatId: c.id, name: 'Bash', summary: 'ls', status: 'running' });
  s.upsertToolCall({ id: 'tc1', chatId: c.id, name: 'Bash', summary: 'ls', status: 'done' });
});

test('usage round-trips', () => {
  const s = new Store(':memory:');
  const r = {
    provider: 'codex' as const, status: 'ok' as const, readAt: '2026-01-01T00:00:00.000Z',
    windows: [
      { kind: 'five_hour' as const, label: '5h', leftPct: 80, resetsAt: '2026-01-01T05:00:00.000Z' },
      { kind: 'weekly' as const, label: 'Week', leftPct: 40, resetsAt: null },
    ],
  };
  s.saveUsage(r);
  assert.deepEqual(s.lastUsage('codex'), r);
  assert.equal(s.lastUsage('claude'), undefined);
});

test('setMessageText replaces the text', () => {
  const s = new Store(':memory:');
  const c = s.createChat({ provider: 'claude', cwd: '/x', title: 't' });
  const m = s.addMessage(c.id, 'assistant', 'par');
  s.setMessageText(m.id, 'final');
  assert.equal(s.listMessages(c.id)[0].text, 'final');
});

test('upsertToolCall returns the stored tool call with a stable createdAt', () => {
  const s = new Store(':memory:');
  const c = s.createChat({ provider: 'claude', cwd: '/x', title: 't' });
  const a = s.upsertToolCall({ id: 'tc1', chatId: c.id, name: 'Bash', summary: 'ls', status: 'running' });
  const b = s.upsertToolCall({ id: 'tc1', chatId: c.id, name: 'Bash', summary: 'ls', status: 'done' });
  assert.equal(b.status, 'done');
  assert.equal(b.createdAt, a.createdAt);
});

test('title is the first non-blank line, trimmed, at most 60 characters; blank prompts get a fallback', () => {
  const s = new Store(':memory:');
  assert.equal(s.createChat({ provider: 'claude', cwd: '/x', title: '\n   \n  Fix the login bug  \nmore' }).title, 'Fix the login bug');
  assert.equal(s.createChat({ provider: 'claude', cwd: '/x', title: '  ' + 'x'.repeat(80) }).title, 'x'.repeat(60));
  assert.equal(s.createChat({ provider: 'claude', cwd: '/x', title: ' \r\n \t ' }).title, 'Untitled chat');
});

test('getMessage reads one message by id', () => {
  const s = new Store(':memory:');
  const c = s.createChat({ provider: 'claude', cwd: '/x', title: 't' });
  const m = s.addMessage(c.id, 'assistant', 'hi');
  assert.deepEqual(s.getMessage(m.id), m);
  assert.equal(s.getMessage('nope'), undefined);
});

test('listToolCalls returns a chat\'s tool calls in order', () => {
  const s = new Store(':memory:');
  const c = s.createChat({ provider: 'claude', cwd: '/x', title: 't' });
  const other = s.createChat({ provider: 'claude', cwd: '/x', title: 'o' });
  s.upsertToolCall({ id: 'a', chatId: c.id, name: 'Bash', summary: 'ls', status: 'running' });
  s.upsertToolCall({ id: 'b', chatId: c.id, name: 'Edit', summary: 'Editing x', status: 'running' });
  s.upsertToolCall({ id: 'a', chatId: c.id, name: 'Bash', summary: 'ls', status: 'done' });
  s.upsertToolCall({ id: 'z', chatId: other.id, name: 'Bash', summary: 'pwd', status: 'done' });
  assert.deepEqual(s.listToolCalls(c.id).map((t) => [t.id, t.status]), [['a', 'done'], ['b', 'running']]);
});

test('requests: open, answered and closed; ids repeat safely across chats', () => {
  const s = new Store(':memory:');
  const c = s.createChat({ provider: 'codex', cwd: '/x', title: 't' });
  const d = s.createChat({ provider: 'codex', cwd: '/x', title: 'u' });
  s.addRequest(c.id, { requestId: '900', kind: 'permission', summary: 'npm test' });
  s.addRequest(c.id, { requestId: '901', kind: 'question', summary: 'Which db?' });
  s.addRequest(d.id, { requestId: '900', kind: 'permission', summary: 'ls' });
  const open = s.listOpenRequests(c.id);
  assert.deepEqual(open.map((r) => [r.requestId, r.kind, r.summary]), [['900', 'permission', 'npm test'], ['901', 'question', 'Which db?']]);
  assert.equal(typeof open[0]!.createdAt, 'string');
  s.setRequestStatus(c.id, '900', 'answered');
  assert.deepEqual(s.listOpenRequests(c.id).map((r) => r.requestId), ['901']);
  s.closeOpenRequests(c.id);
  assert.deepEqual(s.listOpenRequests(c.id), []);
  assert.deepEqual(s.listOpenRequests(d.id).map((r) => r.requestId), ['900']);
  s.closeOpenRequests();
  assert.deepEqual(s.listOpenRequests(d.id), []);
});

test('the store creates its lookup indexes', () => {
  const s = new Store(':memory:');
  const names = ((s as any).db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map((r) => r.name);
  for (const n of ['messages_chat', 'tool_calls_chat', 'requests_chat', 'chats_session']) assert.ok(names.includes(n), n);
});

test('updateChat with touch: false keeps updatedAt', async () => {
  const s = new Store(':memory:');
  const c = s.createChat({ provider: 'codex', cwd: '/x', title: 't' });
  await tick();
  const u = s.updateChat(c.id, { pinned: true }, { touch: false });
  assert.equal(u.pinned, true);
  assert.equal(u.updatedAt, c.updatedAt);
});

test('a permission request keeps what it is for; a database from before the action column gets it', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = mkdtempSync(join(tmpdir(), 'ak-'));
  const file = join(dir, 'old.db');
  const opened: Store[] = [];
  try {
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE requests (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO requests VALUES ('c1:r0', 'c1', 'permission', 'npm test', 'open', '2026-01-01T00:00:00.000Z');`);
    old.close();
    const s = new Store(file);
    opened.push(s);
    s.addRequest('c1', { requestId: 'r1', kind: 'permission', summary: 'Edit a.txt', action: 'edit' });
    s.addRequest('c1', { requestId: 'r2', kind: 'question', summary: 'Which?' });
    const open = s.listOpenRequests('c1');
    assert.deepEqual(open.map((r) => [r.requestId, r.action]), [['r0', undefined], ['r1', 'edit'], ['r2', undefined]]);
    assert.ok(!('action' in open[0]!));
    opened.push(new Store(file)); // opening it again doesn't try to add the column twice
  } finally {
    for (const s of opened) s.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
