import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdapterEvent, ProviderId, ServerEvent } from '@agent-kanban/shared';
import { Store } from '../src/store.ts';
import { ChatService, RESUME_TEXT } from '../src/chats.ts';
import type { ProviderAdapter } from '../src/adapters/adapter.ts';

class FakeAdapter implements ProviderAdapter {
  id: ProviderId = 'codex';
  calls: string[] = [];
  listeners = new Set<(e: AdapterEvent) => void>();
  async startChat() { this.calls.push('startChat'); return { sessionRef: 's1' }; }
  async sendMessage(ref: string, text: string) { this.calls.push(`send:${text}`); }
  async respondToRequest() {}
  async stop() {}
  async resume() { this.calls.push('resume'); }
  onEvent(l: (e: AdapterEvent) => void) { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
  async readUsage(): Promise<never> { throw new Error('unused'); }
  async dispose() {}
  emit(e: AdapterEvent) { for (const l of this.listeners) l(e); }
}

const T0 = Date.parse('2026-11-01T10:00:00.000Z');
const RESET = '2026-11-01T12:40:00.000Z';
const flush = () => new Promise((r) => setTimeout(r, 0));

async function setup(dbPath = ':memory:') {
  let clock = T0;
  const store = new Store(dbPath);
  const adapter = new FakeAdapter();
  const events: ServerEvent[] = [];
  const usage = { refresh: async () => [] };
  const svc = new ChatService({ store, adapters: { codex: adapter }, usage: usage as any, broadcast: (e) => events.push(e), claudeHome: '/nowhere', now: () => new Date(clock) });
  const chat = await svc.start({ provider: 'codex', cwd: '/w', prompt: 'hello' });
  await svc.started(chat.id);
  return { store, adapter, events, svc, id: chat.id, tick: (ms: number) => { clock += ms; }, at: (iso: string) => { clock = Date.parse(iso); } };
}

test('a limit with a reset time makes the chat out of usage, and it resumes at the reset', async () => {
  const s = await setup();
  try {
    s.adapter.emit({ type: 'limit.reached', sessionRef: 's1', resetsAt: RESET });
    let chat = s.svc.getChat(s.id);
    assert.equal(chat.column, 'needs_you');
    assert.equal(chat.needsReason, 'limit');
    assert.equal(chat.resumeAt, RESET);
    s.svc.resumeDue();
    await flush();
    assert.ok(!s.adapter.calls.includes(`send:${RESUME_TEXT}`), 'not before the reset');
    s.at(RESET);
    s.svc.resumeDue();
    await flush();
    assert.ok(s.adapter.calls.includes(`send:${RESUME_TEXT}`));
    chat = s.svc.getChat(s.id);
    assert.equal(chat.column, 'running');
    assert.equal(chat.resumeAt, undefined);
  } finally { s.svc.dispose(); }
});

test('messages sent while out of usage are queued, editable, and sent in order from the reset', async () => {
  const s = await setup();
  try {
    s.adapter.emit({ type: 'limit.reached', sessionRef: 's1', resetsAt: RESET });
    await s.svc.send(s.id, 'first');
    await s.svc.send(s.id, 'second');
    await s.svc.send(s.id, 'third');
    let queue = s.svc.getChat(s.id).queue!;
    assert.deepEqual(queue.map((q) => q.text), ['first', 'second', 'third']);
    s.svc.editQueued(s.id, queue[1]!.id, 'second, edited');
    s.svc.removeQueued(s.id, queue[2]!.id);
    assert.throws(() => s.svc.removeQueued(s.id, 'gone'), /no longer queued/);
    s.at(RESET);
    s.svc.resumeDue();
    await flush();
    assert.ok(s.adapter.calls.includes('send:first'));
    assert.ok(!s.adapter.calls.includes(`send:${RESUME_TEXT}`));
    s.adapter.emit({ type: 'turn.completed', sessionRef: 's1' });
    await flush();
    assert.ok(s.adapter.calls.includes('send:second, edited'));
    queue = s.svc.getChat(s.id).queue ?? [];
    assert.equal(queue.length, 0);
  } finally { s.svc.dispose(); }
});

test("Don't resume keeps it waiting; Send now sends straight away", async () => {
  const s = await setup();
  try {
    s.adapter.emit({ type: 'limit.reached', sessionRef: 's1', resetsAt: RESET });
    s.svc.patch(s.id, { autoResume: false });
    await s.svc.send(s.id, 'later');
    s.at(RESET);
    s.svc.resumeDue();
    await flush();
    assert.ok(!s.adapter.calls.some((c) => c.startsWith('send:')));
    const q = s.svc.getChat(s.id).queue![0]!;
    await s.svc.sendQueuedNow(s.id, q.id);
    assert.ok(s.adapter.calls.includes('send:later'));
  } finally { s.svc.dispose(); }
});

test('no reset time means no automatic resume', async () => {
  const s = await setup();
  try {
    s.adapter.emit({ type: 'limit.reached', sessionRef: 's1' });
    assert.equal(s.svc.getChat(s.id).resumeAt, undefined);
    s.tick(48 * 60 * 60_000);
    s.svc.resumeDue();
    await flush();
    assert.ok(!s.adapter.calls.some((c) => c.startsWith('send:')));
  } finally { s.svc.dispose(); }
});

test('a reset that passed while the app was closed resumes on start', async () => {
  const db = join(mkdtempSync(join(tmpdir(), 'ak-limits-')), 'ak.db');
  const s = await setup(db);
  s.adapter.emit({ type: 'limit.reached', sessionRef: 's1', resetsAt: RESET });
  await s.svc.send(s.id, 'after restart');
  s.svc.dispose();
  s.store.close();

  const store = new Store(db);
  const adapter = new FakeAdapter();
  const svc = new ChatService({ store, adapters: { codex: adapter }, usage: { refresh: async () => [] } as any, broadcast: () => {}, claudeHome: '/nowhere', now: () => new Date(Date.parse(RESET) + 60_000) });
  try {
    svc.recoverAfterRestart();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(adapter.calls.includes('send:after restart'));
  } finally { svc.dispose(); }
});
