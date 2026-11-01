import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdapterEvent, Chat, ProviderId, Routine, ServerEvent } from '@agent-kanban/shared';
import { createApi } from '../src/api.ts';
import { Store } from '../src/store.ts';
import { ChatService } from '../src/chats.ts';
import { RoutineService } from '../src/routines.ts';
import type { ProviderAdapter } from '../src/adapters/adapter.ts';

class FakeAdapter implements ProviderAdapter {
  id: ProviderId = 'codex';
  starts: string[] = [];
  listeners = new Set<(e: AdapterEvent) => void>();
  private n = 0;
  async startChat(opts: { prompt: string }) { this.starts.push(opts.prompt); return { sessionRef: `s${++this.n}` }; }
  async sendMessage() {}
  async respondToRequest() {}
  async stop() {}
  async resume() {}
  onEvent(l: (e: AdapterEvent) => void) { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
  async readUsage(): Promise<never> { throw new Error('unused'); }
  async dispose() {}
  emit(e: AdapterEvent) { for (const l of this.listeners) l(e); }
}

// Local times. 30 Oct 2026 is a Friday, 31 Oct a Saturday.
const FRI_0700 = new Date(2026, 9, 30, 7, 0);
const FRI_0800 = new Date(2026, 9, 30, 8, 0);
const SAT_0800 = new Date(2026, 9, 31, 8, 0);

async function setup(start = FRI_0700) {
  const dir = mkdtempSync(join(tmpdir(), 'ak-routines-'));
  const store = new Store(':memory:');
  const adapter = new FakeAdapter();
  const events: ServerEvent[] = [];
  let emit: (e: ServerEvent) => void = () => {};
  const clock = { now: start };
  const timers: number[] = [];
  const chats = new ChatService({ store, adapters: { codex: adapter } as any, usage: { refresh: async () => [] } as any, broadcast: (e) => emit(e), claudeHome: '/nowhere' });
  const routines = new RoutineService({
    store, chats, broadcast: (e) => emit(e), now: () => clock.now,
    setTimer: (_fn, ms) => { timers.push(ms); return ms; }, clearTimer: () => {},
  });
  const api = createApi({ chats, usage: { latest: () => [] } as any, history: async () => [], routines, token: 'tok' });
  emit = (e) => { events.push(e); api.broadcast(e); };
  await new Promise<void>((r) => api.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  const f = (path: string, method = 'GET', body?: unknown) =>
    fetch(base + path, { method, headers: { Authorization: 'Bearer tok' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const create = async (extra: Record<string, unknown> = {}): Promise<Routine> => {
    const res = await f('/api/routines', 'POST', { name: 'Morning review', cwd: dir, provider: 'codex', text: 'Review yesterday', schedule: { days: [1, 2, 3, 4, 5], time: '08:00' }, ...extra });
    assert.equal(res.status, 201, await res.clone().text());
    return res.json() as Promise<Routine>;
  };
  const get = async (id: string) => ((await (await f('/api/routines')).json()) as Routine[]).find((r) => r.id === id)!;
  const routineChats = () => chats.listChats().filter((c: Chat) => c.routineId);
  const close = () => { api.close(); api.server.closeAllConnections(); api.server.close(); store.close(); rmSync(dir, { recursive: true, force: true }); };
  return { dir, store, adapter, events, clock, timers, chats, routines, f, create, get, routineChats, close };
}

test('create, list, patch and delete a routine; each change broadcasts routines.updated', async () => {
  const s = await setup();
  try {
    const r = await s.create();
    assert.equal(r.effort, 'normal');
    assert.equal(r.kind, 'prompt');
    assert.equal(r.paused, false);
    assert.equal(r.nextRunAt, FRI_0800.toISOString());
    const patched = await (await s.f(`/api/routines/${r.id}`, 'PATCH', { name: 'Tidy', effort: 'thorough', kind: 'skill', chime: true })).json() as Routine;
    assert.deepEqual([patched.name, patched.effort, patched.kind, patched.chime], ['Tidy', 'thorough', 'skill', true]);
    assert.equal((await s.f(`/api/routines/${r.id}`, 'DELETE')).status, 204);
    assert.deepEqual(await (await s.f('/api/routines')).json(), []);
    assert.equal(s.events.filter((e) => e.type === 'routines.updated').length, 3);
    assert.equal((await s.f(`/api/routines/${r.id}`, 'DELETE')).status, 404);
  } finally { s.close(); }
});

test('validation: time format, at least one day, folder, provider, unknown fields', async () => {
  const s = await setup();
  try {
    const good = { name: 'n', cwd: s.dir, provider: 'codex', text: 't', schedule: { days: [1], time: '08:00' } };
    for (const bad of [
      { ...good, schedule: { days: [1], time: '8am' } },
      { ...good, schedule: { days: [1], time: '24:00' } },
      { ...good, schedule: { days: [], time: '08:00' } },
      { ...good, schedule: { days: [7], time: '08:00' } },
      { ...good, cwd: join(s.dir, 'nope') },
      { ...good, provider: 'nope' },
      { ...good, effort: 'max' },
      { ...good, name: '' },
      { ...good, colour: 'red' },
      { name: 'n' },
    ]) {
      const res = await s.f('/api/routines', 'POST', bad);
      assert.equal(res.status, 400, JSON.stringify(bad));
      assert.equal(typeof ((await res.json()) as { error: string }).error, 'string');
    }
  } finally { s.close(); }
});

test('a due run starts a chat titled "Name · 30 Oct" that ends in Review', async () => {
  const s = await setup();
  try {
    const r = await s.create();
    assert.equal(s.timers.at(-1), FRI_0800.getTime() - FRI_0700.getTime());
    s.clock.now = FRI_0800;
    await s.routines.tick();
    const [chat] = s.routineChats();
    assert.equal(chat!.title, 'Morning review · 30 Oct');
    assert.equal(chat!.routineId, r.id);
    assert.deepEqual(s.adapter.starts, ['Review yesterday']);
    const after = await s.get(r.id);
    assert.equal(after.lastResult, 'ran');
    assert.equal(after.lastChatId, chat!.id);
    await s.chats.started(chat!.id);
    s.adapter.emit({ type: 'turn.completed', sessionRef: 's1' });
    assert.equal(s.chats.getChat(chat!.id).column, 'review');
    // The same due time never runs twice.
    await s.routines.tick();
    assert.equal(s.routineChats().length, 1);
  } finally { s.close(); }
});

test('Weekdays does not run on Saturday', async () => {
  const s = await setup(new Date(2026, 9, 31, 7, 0));
  try {
    await s.create();
    s.clock.now = SAT_0800;
    await s.routines.tick();
    assert.equal(s.routineChats().length, 0);
  } finally { s.close(); }
});

test('Pause stops runs; Resume does not catch up a run due while paused', async () => {
  const s = await setup();
  try {
    const r = await s.create();
    const paused = await (await s.f(`/api/routines/${r.id}`, 'PATCH', { paused: true })).json() as Routine;
    assert.equal(paused.nextRunAt, null);
    s.clock.now = FRI_0800;
    await s.routines.tick();
    assert.equal(s.routineChats().length, 0);
    s.clock.now = new Date(2026, 9, 30, 9, 0);
    await s.f(`/api/routines/${r.id}`, 'PATCH', { paused: false });
    await s.routines.tick();
    assert.equal(s.routineChats().length, 0);
  } finally { s.close(); }
});

test('Run now starts a chat at once', async () => {
  const s = await setup(new Date(2026, 9, 31, 7, 0));
  try {
    const r = await s.create();
    const res = await s.f(`/api/routines/${r.id}/run`, 'POST');
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as Routine).lastResult, 'ran');
    assert.equal(s.routineChats()[0]!.title, 'Morning review · 31 Oct');
    assert.equal((await s.f('/api/routines/nope/run', 'POST')).status, 404);
  } finally { s.close(); }
});

test('a run is skipped while the previous one is still running', async () => {
  const s = await setup();
  try {
    const r = await s.create({ schedule: { days: [0, 1, 2, 3, 4, 5, 6], time: '08:00' } });
    await s.f(`/api/routines/${r.id}/run`, 'POST');
    s.clock.now = FRI_0800;
    await s.routines.tick();
    assert.equal(s.routineChats().length, 1);
    assert.equal((await s.get(r.id)).lastResult, 'skipped_running');
  } finally { s.close(); }
});

test('a run missed within 12 h runs on start marked late; one missed past 12 h does not', async () => {
  const s = await setup(new Date(2026, 9, 29, 7, 0));
  try {
    const r = await s.create({ schedule: { days: [0, 1, 2, 3, 4, 5, 6], time: '08:00' } });
    // The app "reopens" at 19:59 the same day: 11 h 59 m after 08:00.
    s.clock.now = new Date(2026, 9, 29, 19, 59);
    await s.routines.start();
    assert.equal(s.routineChats().length, 1);
    assert.equal((await s.get(r.id)).lastResult, 'ran_late');
  } finally { s.close(); }
  const s2 = await setup(new Date(2026, 9, 29, 7, 0));
  try {
    await s2.create({ schedule: { days: [0, 1, 2, 3, 4, 5, 6], time: '08:00' } });
    s2.clock.now = new Date(2026, 9, 29, 20, 1);
    await s2.routines.start();
    assert.equal(s2.routineChats().length, 0);
  } finally { s2.close(); }
});

test('a missing folder pauses the routine with folder_missing', async () => {
  const s = await setup();
  try {
    const r = await s.create();
    rmSync(s.dir, { recursive: true, force: true });
    s.clock.now = FRI_0800;
    await s.routines.tick();
    const after = await s.get(r.id);
    assert.equal(s.routineChats().length, 0);
    assert.equal(after.paused, true);
    assert.equal(after.lastResult, 'folder_missing');
  } finally { s.close(); }
});
