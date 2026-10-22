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
