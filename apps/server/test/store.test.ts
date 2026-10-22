import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
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
