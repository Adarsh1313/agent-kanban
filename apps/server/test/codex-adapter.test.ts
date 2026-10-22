import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { CodexAdapter } from '../src/adapters/codex.ts';
import { JsonRpcProcess } from '../src/adapters/jsonrpc.ts';
import { codexLimitsToReading } from '../src/usage/parse.ts';
import type { AdapterEvent } from '@agent-kanban/shared';

const fake = fileURLToPath(new URL('./fixtures/fake-codex-app-server.ts', import.meta.url));

function make(scenario: string | ((n: number) => string), adapterOpts: { initializeTimeoutMs?: number } = {}) {
  const procs: JsonRpcProcess[] = [];
  const adapter = new CodexAdapter({
    codexPath: 'unused',
    ...adapterOpts,
    spawn: () => {
      const sc = typeof scenario === 'string' ? scenario : scenario(procs.length);
      const p = new JsonRpcProcess(process.execPath, ['--disable-warning=ExperimentalWarning', fake], { env: { ...process.env, FAKE_SCENARIO: sc } });
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
