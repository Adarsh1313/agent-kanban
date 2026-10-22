import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAdapter } from '../src/adapters/codex.ts';
import { JsonRpcProcess } from '../src/adapters/jsonrpc.ts';
import { codexLimitsToReading } from '../src/usage/parse.ts';
import type { AdapterEvent } from '@agent-kanban/shared';

const fake = fileURLToPath(new URL('./fixtures/fake-codex-app-server.ts', import.meta.url));

function make(scenario: string | ((n: number) => string), adapterOpts: { initializeTimeoutMs?: number; codexHome?: string; env?: Record<string, string> } = {}) {
  const procs: JsonRpcProcess[] = [];
  const adapter = new CodexAdapter({
    codexPath: 'unused',
    initializeTimeoutMs: adapterOpts.initializeTimeoutMs,
    codexHome: adapterOpts.codexHome ?? join(tmpdir(), 'ak-no-codex-home'),
    spawn: () => {
      const sc = typeof scenario === 'string' ? scenario : scenario(procs.length);
      const p = new JsonRpcProcess(process.execPath, ['--disable-warning=ExperimentalWarning', fake], { env: { ...process.env, FAKE_SCENARIO: sc, ...adapterOpts.env } });
      procs.push(p);
      return p;
    },
  });
  const events: AdapterEvent[] = [];
  adapter.onEvent((e) => events.push(e));
  const waitFor = async (pred: (e: AdapterEvent) => boolean) => {
    for (let i = 0; i < 500; i++) {
      const hit = events.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('timed out; events: ' + JSON.stringify(events));
  };
  return { adapter, procs, events, waitFor };
}

const limitsFixture = {
  rateLimits: {
    limitId: 'codex', limitName: null,
    primary: { usedPercent: 69, windowDurationMins: 300, resetsAt: 1792680600 },
    secondary: { usedPercent: 82, windowDurationMins: 10080, resetsAt: 1792944000 },
  },
};
const cwd = process.cwd();

test('happy path emits events in order', async () => {
  const { adapter, events, waitFor } = make('');
  try {
    const r = await adapter.startChat({ cwd, prompt: 'hi' });
    assert.deepEqual(r, { sessionRef: 'thr_1' });
    await waitFor((e) => e.type === 'turn.completed');
    assert.deepEqual(events.map((e) => e.type), ['session.started', 'turn.started', 'message.delta', 'message.delta', 'message.completed', 'turn.completed']);
    const done = events.find((e) => e.type === 'message.completed');
    assert.ok(done?.type === 'message.completed');
    assert.equal(done.text, 'Hello world');
  } finally { await adapter.dispose(); }
});

test('approval request waits for respondToRequest', async () => {
  const { adapter, waitFor, events } = make('approval');
  try {
    await adapter.startChat({ cwd, prompt: 'hi' });
    const req = await waitFor((e) => e.type === 'request.opened');
    assert.ok(req.type === 'request.opened');
    assert.equal(req.kind, 'permission');
    assert.equal(req.summary, 'npm test');
    assert.equal(req.requestId, '900');
    assert.ok(!events.some((e) => e.type === 'turn.completed'));
    await adapter.respondToRequest('thr_1', req.requestId, 'allow');
    await waitFor((e) => e.type === 'turn.completed');
  } finally { await adapter.dispose(); }
});

test('file change approval opens a request and accept completes the turn', async () => {
  const { adapter, waitFor } = make('fileapproval');
  try {
    await adapter.startChat({ cwd, prompt: 'hi' });
    const req = await waitFor((e) => e.type === 'request.opened');
    assert.ok(req.type === 'request.opened');
    assert.equal(req.summary, 'Edit a.txt');
    assert.equal(req.requestId, '901');
    await adapter.respondToRequest('thr_1', req.requestId, 'allow');
    await waitFor((e) => e.type === 'turn.completed');
  } finally { await adapter.dispose(); }
});

test('a reply decision declines, so the turn does not complete', async () => {
  const { adapter, waitFor, events } = make('approval');
  try {
    await adapter.startChat({ cwd, prompt: 'hi' });
    const req = await waitFor((e) => e.type === 'request.opened');
    assert.ok(req.type === 'request.opened');
    await adapter.respondToRequest('thr_1', req.requestId, { reply: 'no thanks' });
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!events.some((e) => e.type === 'turn.completed'));
  } finally { await adapter.dispose(); }
});

test('crash emits error; next action respawns, re-attaches the thread and completes a turn', async () => {
  const { adapter, procs, events, waitFor } = make((n) => (n === 0 ? 'crash' : ''));
  try {
    await adapter.startChat({ cwd, prompt: 'hi' });
    const err = await waitFor((e) => e.type === 'error');
    assert.ok(err.type === 'error');
    assert.equal(err.sessionRef, 'thr_1');
    assert.equal(err.message, 'Codex stopped unexpectedly.');
    assert.equal(procs.length, 1);
    await adapter.sendMessage('thr_1', 'again');
    assert.equal(procs.length, 2);
    await waitFor((e) => e.type === 'turn.completed');
    assert.ok(events.some((e) => e.type === 'message.completed'));
  } finally { await adapter.dispose(); }
});

test('stop interrupts the running turn', async () => {
  const { adapter, waitFor } = make('hang');
  try {
    await adapter.startChat({ cwd, prompt: 'hi' });
    await waitFor((e) => e.type === 'turn.started');
    await adapter.stop('thr_1');
    await waitFor((e) => e.type === 'stopped');
  } finally { await adapter.dispose(); }
});

test('stop before the turn id is known interrupts once it arrives', async () => {
  const { adapter, waitFor } = make('slowturn');
  try {
    const started = adapter.startChat({ cwd, prompt: 'hi' });
    await waitFor((e) => e.type === 'session.started');
    await adapter.stop('thr_1');
    await started;
    await waitFor((e) => e.type === 'stopped');
  } finally { await adapter.dispose(); }
});

test('initialize timeout rejects, kills the process, and a later call spawns again', async () => {
  const { adapter, procs } = make((n) => (n === 0 ? 'hanginit' : ''), { initializeTimeoutMs: 300 });
  try {
    await assert.rejects(adapter.startChat({ cwd, prompt: 'hi' }));
    assert.equal(procs.length, 1);
    const r = await adapter.startChat({ cwd, prompt: 'hi' });
    assert.equal(r.sessionRef, 'thr_1');
    assert.equal(procs.length, 2);
  } finally { await adapter.dispose(); }
});

test('dispose does not hang while initialize is pending', async () => {
  const { adapter } = make('hanginit', { initializeTimeoutMs: 60_000 });
  const started = adapter.startChat({ cwd, prompt: 'hi' }).catch(() => {});
  await new Promise((r) => setTimeout(r, 150));
  await adapter.dispose();
  await started;
});

test('concurrent startChat shares one process', async () => {
  const { adapter, procs } = make('');
  try {
    await Promise.all([adapter.startChat({ cwd, prompt: 'a' }), adapter.startChat({ cwd, prompt: 'b' })]);
    assert.equal(procs.length, 1);
  } finally { await adapter.dispose(); }
});

test('command and file change items map to tool.call', async () => {
  const { adapter, waitFor, events } = make('tools');
  try {
    await adapter.startChat({ cwd, prompt: 'hi' });
    await waitFor((e) => e.type === 'turn.completed');
    const calls = events.filter((e) => e.type === 'tool.call').map((c) => (c.type === 'tool.call' ? [c.toolCallId, c.summary, c.status] : []));
    assert.deepEqual(calls, [
      ['cmd_1', 'Running ls', 'running'],
      ['cmd_1', 'Running ls', 'done'],
      ['fc_1', 'Editing a.txt', 'failed'],
    ]);
  } finally { await adapter.dispose(); }
});

test('rate limit reached maps to limit.reached', async () => {
  const { adapter, waitFor } = make('limit');
  try {
    await adapter.startChat({ cwd, prompt: 'hi' });
    const e = await waitFor((x) => x.type === 'limit.reached');
    assert.ok(e.type === 'limit.reached');
    assert.equal(e.sessionRef, 'thr_1');
    assert.equal(e.resetsAt, new Date(1792680600 * 1000).toISOString());
  } finally { await adapter.dispose(); }
});

test('after dispose nothing spawns', async () => {
  const { adapter, procs } = make('');
  await adapter.dispose();
  await assert.rejects(adapter.startChat({ cwd, prompt: 'hi' }), /shut down/);
  assert.equal(procs.length, 0);
});

test('readUsage maps rate limits', async () => {
  const { adapter } = make('limits');
  try {
    const r = await adapter.readUsage();
    const expected = codexLimitsToReading(limitsFixture, new Date());
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.windows, expected.windows);
  } finally { await adapter.dispose(); }
});

test('readUsage failure returns error reading', async () => {
  const { adapter } = make('');
  try {
    const r = await adapter.readUsage();
    assert.equal(r.status, 'error');
    assert.deepEqual(r.windows, []);
    assert.equal(r.message, "Couldn't read Codex usage.");
  } finally { await adapter.dispose(); }
});

function modelCase(configured: string, models: object[]) {
  const home = mkdtempSync(join(tmpdir(), 'ak-home-'));
  writeFileSync(join(home, 'config.toml'), `model = "${configured}"
model_reasoning_effort = "medium"
`);
  const log = join(home, 'calls.log');
  writeFileSync(log, '');
  const m = make('', { codexHome: home, env: { FAKE_LOG: log, FAKE_MODELS: JSON.stringify(models) } });
  const started = async () => {
    await m.adapter.startChat({ cwd, prompt: 'hi' });
    const lines = readFileSync(log, 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l));
    return lines.find((l) => l.method === 'thread/start').params.model;
  };
  return { ...m, started };
}
const catalog = [
  { id: 'gpt-a', model: 'gpt-a', isDefault: true, hidden: false },
  { id: 'gpt-b', model: 'gpt-b', isDefault: false, hidden: false },
];

test('X1: configured model that the account lists -> model null, no note', async () => {
  const c = modelCase('gpt-b', catalog);
  try {
    assert.equal(await c.started(), null);
    assert.equal(c.adapter.modelNote, null);
  } finally { await c.adapter.dispose(); }
});

test('X1: configured model not listed -> default model id and a note', async () => {
  const c = modelCase('gpt-zzz', catalog);
  try {
    assert.equal(await c.started(), 'gpt-a');
    assert.equal(c.adapter.modelNote, "Your Codex settings use gpt-zzz, which your account can't use, so new chats use gpt-a.");
  } finally { await c.adapter.dispose(); }
});

test('M1: only top-level model counts; M4: resume uses the fallback model; note resets', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ak-home-'));
  writeFileSync(join(home, 'config.toml'), 'model = "gpt-zzz"\n[profiles.x]\nmodel = "gpt-b"\n');
  const log = join(home, 'calls.log');
  writeFileSync(log, '');
  const m = make('', { codexHome: home, env: { FAKE_LOG: log, FAKE_MODELS: JSON.stringify(catalog) } });
  try {
    await m.adapter.resume('thr_9', cwd);
    const calls = readFileSync(log, 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l));
    assert.equal(calls.find((c) => c.method === 'thread/resume').params.model, 'gpt-a');
    assert.match(m.adapter.modelNote ?? '', /gpt-zzz/);
  } finally { await m.adapter.dispose(); }
});

// ---- Task 10: ping, keep-alive backoff, carry-forward fixes ----
test('ping reports signed in / signed out from account/read', async () => {
  const a = make('');
  try {
    assert.deepEqual(await a.adapter.ping(), { ok: true, signedIn: true });
  } finally { await a.adapter.dispose(); }
  const b = make('', { env: { FAKE_SIGNED_OUT: '1' } });
  try {
    assert.deepEqual(await b.adapter.ping(), { ok: true, signedIn: false });
  } finally { await b.adapter.dispose(); }
});

test('ping surfaces the model note without changing ok', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ak-codex-'));
  writeFileSync(join(home, 'config.toml'), 'model = "gpt-9"\n');
  const models = JSON.stringify([{ id: 'gpt-5', model: 'gpt-5', isDefault: true }]);
  const { adapter } = make('', { codexHome: home, env: { FAKE_MODELS: models } });
  try {
    const r = await adapter.ping();
    assert.equal(r.ok, true);
    assert.match(r.message ?? '', /Your Codex settings use gpt-9/);
  } finally { await adapter.dispose(); }
});

test('automatic pings respawn a dying app-server after 1 s, 2 s, 4 s, then give up until a manual check', async () => {
  mock.timers.enable({ apis: ['Date'], now: 0 });
  const { adapter, procs } = make((n) => (n < 4 ? 'dieonaccount' : ''));
  try {
    assert.equal((await adapter.ping()).ok, false);
    assert.equal(procs.length, 1);
    assert.equal((await adapter.ping()).ok, false);
    assert.equal(procs.length, 1, 'no respawn inside the 1 s backoff');
    mock.timers.tick(1000);
    assert.equal((await adapter.ping()).ok, false);
    assert.equal(procs.length, 2);
    mock.timers.tick(1999);
    await adapter.ping();
    assert.equal(procs.length, 2, 'second gap is 2 s');
    mock.timers.tick(1);
    await adapter.ping();
    assert.equal(procs.length, 3);
    mock.timers.tick(3999);
    await adapter.ping();
    assert.equal(procs.length, 3, 'third gap is 4 s');
    mock.timers.tick(1);
    await adapter.ping();
    assert.equal(procs.length, 4);
    mock.timers.tick(120_000);
    const stuck = await adapter.ping();
    assert.equal(stuck.ok, false);
    assert.equal(procs.length, 4, 'stays down until a manual check');
    const manual = await adapter.ping({ manual: true });
    assert.equal(manual.ok, true);
    assert.equal(procs.length, 5);
    assert.equal((await adapter.ping()).ok, true);
  } finally { mock.timers.reset(); await adapter.dispose(); }
});

test('a healthy app-server killed from outside shows one failed ping, then respawns after 1 s', async () => {
  mock.timers.enable({ apis: ['Date'], now: 0 });
  const { adapter, procs } = make('');
  try {
    assert.equal((await adapter.ping()).ok, true);
    await procs[0]!.close();
    const down = await adapter.ping();
    assert.equal(down.ok, false);
    assert.equal(procs.length, 1);
    mock.timers.tick(1000);
    assert.equal((await adapter.ping()).ok, true);
    assert.equal(procs.length, 2);
  } finally { mock.timers.reset(); await adapter.dispose(); }
});

test('user actions respawn a crashed app-server immediately even inside the ping backoff', async () => {
  mock.timers.enable({ apis: ['Date'], now: 0 });
  const { adapter, procs } = make((n) => (n === 0 ? 'dieonaccount' : ''));
  try {
    assert.equal((await adapter.ping()).ok, false);
    await adapter.startChat({ cwd, prompt: 'hi' });
    assert.equal(procs.length, 2);
    assert.equal((await adapter.ping()).ok, true);
  } finally { mock.timers.reset(); await adapter.dispose(); }
});

function makeHangingFirst(pingTimeoutMs: number) {
  const procs: JsonRpcProcess[] = [];
  const adapter = new CodexAdapter({
    codexPath: 'unused', codexHome: join(tmpdir(), 'ak-no-codex-home'), pingTimeoutMs,
    spawn: () => {
      const p = new JsonRpcProcess(process.execPath, ['--disable-warning=ExperimentalWarning', fake], { env: { ...process.env, FAKE_SCENARIO: procs.length === 0 ? 'hangaccount' : '' } });
      procs.push(p);
      return p;
    },
  });
  return { adapter, procs };
}

test('a ping timeout marks the process unhealthy; the next ping kills and respawns it', async () => {
  mock.timers.enable({ apis: ['Date'], now: 0 });
  const { adapter, procs } = makeHangingFirst(150);
  try {
    assert.equal((await adapter.ping()).ok, false);
    assert.equal(procs[0]!.unhealthy, true);
    mock.timers.tick(1000);
    assert.equal((await adapter.ping()).ok, true);
    assert.equal(procs.length, 2);
    let exited = false;
    procs[0]!.onExit(() => { exited = true; }); // fires immediately if it already exited
    assert.equal(exited, true, 'the unresponsive process was killed');
  } finally { mock.timers.reset(); await adapter.dispose(); }
});

test('a user action recycles an unhealthy app-server right away', async () => {
  const { adapter, procs } = makeHangingFirst(150);
  try {
    assert.equal((await adapter.ping()).ok, false);
    const r = await adapter.startChat({ cwd, prompt: 'hi' });
    assert.equal(r.sessionRef, 'thr_1');
    assert.equal(procs.length, 2);
  } finally { await adapter.dispose(); }
});

test('stop during a re-attach after a respawn is applied once the turn id is known', async () => {
  const { adapter, procs, events, waitFor } = make('hang', { env: { FAKE_RESUME_DELAY_MS: '300' } });
  try {
    await adapter.startChat({ cwd, prompt: 'hi' });
    await waitFor((e) => e.type === 'turn.started');
    await procs[0]!.close();
    await waitFor((e) => e.type === 'error');
    events.length = 0;
    const sending = adapter.sendMessage('thr_1', 'again');
    await new Promise((r) => setTimeout(r, 50)); // thread/resume is still in flight
    await adapter.stop('thr_1');
    await sending;
    await waitFor((e) => e.type === 'stopped');
  } finally { await adapter.dispose(); }
});

test('a crash that a usage read already recovered from is still reported once by the next ping', async () => {
  mock.timers.enable({ apis: ['Date'], now: 0 });
  const { adapter, procs } = make('');
  try {
    assert.equal((await adapter.ping()).ok, true);
    await procs[0]!.close(); // killed from outside
    await adapter.readUsage(); // the usage poll respawns it first (a user-path action)
    assert.equal(procs.length, 2);
    const noticed = await adapter.ping();
    assert.equal(noticed.ok, false);
    assert.match(noticed.message ?? '', /restarted/);
    assert.equal(procs.length, 2, 'no extra spawn');
    assert.equal((await adapter.ping()).ok, true, 'and healthy straight after');
  } finally { mock.timers.reset(); await adapter.dispose(); }
});
