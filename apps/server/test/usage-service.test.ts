import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { UsageReading } from '@agent-kanban/shared';
import { Store } from '../src/store.ts';
import { UsageService, notInstalledReading } from '../src/usage/service.ts';

const good = (provider: 'claude' | 'codex' | 'antigravity', used = 10): UsageReading => ({
  provider,
  status: 'ok',
  windows: [{ kind: 'five_hour', label: '5-hour', leftPct: 100 - used, resetsAt: null }],
  readAt: new Date().toISOString(),
});
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test('start() reads every provider immediately and again after 60s', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const calls = { claude: 0, codex: 0 };
  const svc = new UsageService({
    readers: { claude: async () => (calls.claude++, good('claude')), codex: async () => (calls.codex++, good('codex')) },
    store: new Store(':memory:'),
    onUpdate: () => {},
  });
  svc.start();
  await flush();
  assert.deepEqual(calls, { claude: 1, codex: 1 });
  t.mock.timers.tick(60_000);
  await flush();
  assert.deepEqual(calls, { claude: 2, codex: 2 });
  svc.stop();
});

test('concurrent refresh shares one read', async () => {
  let n = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const svc = new UsageService({
    readers: { codex: async () => { n++; await gate; return good('codex'); } },
    store: new Store(':memory:'),
    onUpdate: () => {},
  });
  const a = svc.refresh('codex');
  const b = svc.refresh('codex');
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(n, 1);
  assert.deepEqual(ra, rb);
});

test('a throwing reader keeps the last good windows', async () => {
  const store = new Store(':memory:');
  let fail = false;
  const seen: UsageReading[] = [];
  const svc = new UsageService({
    readers: { codex: async () => { if (fail) throw new Error('boom'); return good('codex', 42); } },
    store,
    onUpdate: (r) => seen.push(r),
  });
  await svc.refresh('codex');
  fail = true;
  await svc.refresh('codex');
  const last = seen[seen.length - 1];
  assert.equal(last.status, 'error');
  assert.equal(last.message, "Couldn't read Codex usage. Showing the last numbers we had.");
  assert.deepEqual(last.windows, good('codex', 42).windows);
  assert.equal(store.lastUsage('codex')?.status, 'ok');
  assert.deepEqual(store.lastUsage('codex')?.windows, last.windows);
  assert.equal(svc.latest()[0].status, 'error');
});

test('error with no prior reading has empty windows', async () => {
  const svc = new UsageService({
    readers: { claude: async () => { throw new Error('x'); } },
    store: new Store(':memory:'),
    onUpdate: () => {},
  });
  const [r] = await svc.refresh('claude');
  assert.equal(r.status, 'error');
  assert.deepEqual(r.windows, []);
  assert.equal(r.message, "Couldn't read Claude Code usage. Showing the last numbers we had.");
});

test('a hung reader times out and the next refresh calls it again', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  let n = 0;
  const svc = new UsageService({
    readers: { codex: () => { n++; return new Promise<UsageReading>(() => {}); } },
    store: new Store(':memory:'),
    onUpdate: () => {},
    timeoutMs: 15_000,
  });
  const p = svc.refresh('codex');
  await flush();
  t.mock.timers.tick(15_000);
  const [r] = await p;
  assert.equal(r.status, 'error');
  const p2 = svc.refresh('codex');
  await flush();
  assert.equal(n, 2);
  t.mock.timers.tick(15_000);
  await p2;
});

test('a reading for an uninstalled provider is shown as unavailable and never stored as the last good numbers', async () => {
  const store = new Store(':memory:');
  const updates: UsageReading[] = [];
  const svc = new UsageService({ readers: { codex: async () => notInstalledReading('codex') }, store, onUpdate: (r) => updates.push(r) });
  const [r] = await svc.refresh('codex');
  assert.equal(r!.status, 'unavailable');
  assert.equal(r!.message, "Codex isn't installed.");
  assert.deepEqual(r!.windows, []);
  assert.ok(!store.lastUsage('codex'));
  assert.equal(updates.length, 1);
});

test('a returned error reading keeps the last good windows and the adapter message, and is not saved', async () => {
  const store = new Store(':memory:');
  let fail = false;
  const seen: UsageReading[] = [];
  const svc = new UsageService({
    readers: {
      codex: async () => (fail
        ? { provider: 'codex', status: 'error', windows: [], readAt: new Date().toISOString(), message: "Couldn't read Codex usage." }
        : good('codex', 42)),
    },
    store,
    onUpdate: (r) => seen.push(r),
  });
  await svc.refresh('codex');
  fail = true;
  await svc.refresh('codex');
  const last = seen.at(-1)!;
  assert.equal(last.status, 'error');
  assert.equal(last.message, "Couldn't read Codex usage.");
  assert.deepEqual(last.windows, good('codex', 42).windows);
  assert.equal(store.lastUsage('codex')?.status, 'ok', 'the error reading is not stored');
});

test('a throwing onUpdate never becomes an unhandled rejection and the next timer read still runs', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  t.mock.method(console, 'error', () => {});
  let unhandled = 0;
  const onUnhandled = () => { unhandled++; };
  process.on('unhandledRejection', onUnhandled);
  let reads = 0;
  const svc = new UsageService({
    readers: { codex: async () => (reads++, good('codex')) },
    store: new Store(':memory:'),
    onUpdate: () => { throw new Error('listener broke'); },
  });
  try {
    svc.start();
    await flush();
    t.mock.timers.tick(60_000);
    await flush();
    await new Promise((r) => setImmediate(r));
    assert.equal(reads, 2);
    assert.equal(unhandled, 0);
    assert.equal(svc.latest()[0]!.status, 'ok');
  } finally {
    svc.stop();
    process.off('unhandledRejection', onUnhandled);
  }
});

test('a store that fails while looking up the last numbers still reports an error reading', async (t) => {
  t.mock.method(console, 'error', () => {});
  const store = new Store(':memory:');
  (store as any).lastUsage = () => { throw new Error('db gone'); };
  const svc = new UsageService({ readers: { claude: async () => { throw new Error('x'); } }, store, onUpdate: () => {} });
  const [r] = await svc.refresh('claude');
  assert.equal(r!.status, 'error');
  assert.deepEqual(r!.windows, []);
});

test('refresh() with no provider reads every provider; latest() holds one reading each; stop() ends the timer', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const calls = { claude: 0, codex: 0 };
  const svc = new UsageService({
    readers: { claude: async () => (calls.claude++, good('claude')), codex: async () => (calls.codex++, good('codex')) },
    store: new Store(':memory:'),
    onUpdate: () => {},
  });
  const all = await svc.refresh();
  assert.deepEqual(all.map((r) => r.provider).sort(), ['claude', 'codex']);
  await svc.refresh('codex');
  assert.deepEqual(svc.latest().map((r) => r.provider).sort(), ['claude', 'codex']);
  svc.start();
  await flush();
  svc.stop();
  const before = { ...calls };
  t.mock.timers.tick(5 * 60_000);
  await flush();
  assert.deepEqual(calls, before, 'no reads after stop()');
  assert.deepEqual(await svc.refresh('antigravity'), [], 'a provider with no reader gives nothing');
});
