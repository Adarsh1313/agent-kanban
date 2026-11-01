import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Chat, HistoryChat } from '@agent-kanban/shared';
import { TrashError, TrashService } from '../src/trash.ts';

const baseChat = (patch: Partial<Chat> = {}): Chat => ({
  id: 'c1', provider: 'claude', sessionRef: 'session-1', cwd: '/work', title: 'Old chat', model: null,
  column: 'review', needsReason: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
  doneAt: null, archived: false, pinned: false, snoozedUntil: null, effort: 'normal', ...patch,
});

test('Claude delete moves the jsonl and sidecar to Trash; restore puts both back', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ak-trash-home-'));
  const dataDir = join(home, '.agent-kanban');
  const project = join(home, '.claude', 'projects', 'proj');
  mkdirSync(join(project, 'session-1'), { recursive: true });
  writeFileSync(join(project, 'session-1.jsonl'), '{"type":"user"}\n');
  writeFileSync(join(project, 'session-1', 'tool.txt'), 'x');
  const trash = new TrashService({ home, dataDir, now: () => new Date('2026-02-01T00:00:00Z') });
  const entry = await trash.deleteChat(baseChat());
  assert.equal(existsSync(join(project, 'session-1.jsonl')), false);
  assert.equal(existsSync(join(project, 'session-1')), false);
  assert.equal((await trash.list())[0]?.daysLeft, 30);
  await trash.restore(entry.id);
  assert.equal(readFileSync(join(project, 'session-1.jsonl'), 'utf8'), '{"type":"user"}\n');
  assert.equal(readFileSync(join(project, 'session-1', 'tool.txt'), 'utf8'), 'x');
  assert.deepEqual(await trash.list(), []);
});

test('Codex delete removes the rollout and index lines; restore returns both', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ak-trash-codex-'));
  const dataDir = join(home, '.agent-kanban');
  const id = '11111111-2222-3333-4444-555555555555';
  const sessions = join(home, '.codex', 'sessions', '2026', '02', '01');
  mkdirSync(sessions, { recursive: true });
  const rollout = join(sessions, `rollout-2026-02-01T00-00-00-${id}.jsonl`);
  writeFileSync(rollout, '{"type":"session_meta","payload":{"cwd":"/work"}}\n');
  const index = join(home, '.codex', 'session_index.jsonl');
  writeFileSync(index, `${JSON.stringify({ id, thread_name: 'Mine' })}\n${JSON.stringify({ id: 'other', thread_name: 'Keep' })}\n`);
  const trash = new TrashService({ home, dataDir });
  const h: HistoryChat = { provider: 'codex', sessionRef: id, title: 'Mine', cwd: '/work', updatedAt: '2026-02-01T00:00:00Z' };
  const entry = await trash.deleteHistory(h);
  assert.equal(existsSync(rollout), false);
  assert.doesNotMatch(readFileSync(index, 'utf8'), new RegExp(id));
  await trash.restore(entry.id);
  assert.equal(existsSync(rollout), true);
  assert.match(readFileSync(index, 'utf8'), new RegExp(id));
  assert.match(readFileSync(index, 'utf8'), /other/);
});

test('running and Antigravity chats are refused with their API statuses', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ak-trash-refuse-'));
  const trash = new TrashService({ home, dataDir: join(home, '.agent-kanban') });
  await assert.rejects(trash.deleteChat(baseChat({ column: 'running' })), (e: Error) => e instanceof TrashError && e.status === 409 && e.message === 'Stop it first.');
  await assert.rejects(trash.deleteChat(baseChat({ provider: 'antigravity' })), (e: Error) => e instanceof TrashError && e.status === 422);
});

test('purge removes entries after 30 days and empty removes all entries', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ak-trash-purge-'));
  const dataDir = join(home, '.agent-kanban');
  const project = join(home, '.claude', 'projects', 'proj');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'session-1.jsonl'), '{}\n');
  let now = new Date('2026-01-01T00:00:00Z');
  const trash = new TrashService({ home, dataDir, now: () => now });
  await trash.deleteChat(baseChat());
  now = new Date('2026-01-31T00:00:01Z');
  assert.equal(await trash.purge(), 1);
  assert.deepEqual(await trash.list(), []);
  writeFileSync(join(project, 'session-1.jsonl'), '{}\n');
  await trash.deleteChat(baseChat());
  await trash.empty();
  assert.deepEqual(await trash.list(), []);
});
