import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { CodexAdapter } from '../src/adapters/codex.ts';
import { JsonRpcProcess } from '../src/adapters/jsonrpc.ts';
import { codexLimitsToReading } from '../src/usage/parse.ts';
import type { AdapterEvent } from '@agent-kanban/shared';

const fake = fileURLToPath(new URL('./fixtures/fake-codex-app-server.ts', import.meta.url));

function make(scenario: string) {
  const procs: JsonRpcProcess[] = [];
  const adapter = new CodexAdapter({
    codexPath: 'unused',
    spawn: () => {
      const p = new JsonRpcProcess(process.execPath, ['--disable-warning=ExperimentalWarning', fake], { env: { ...process.env, FAKE_SCENARIO: scenario } });
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

test('happy path emits events in order', async () => {
  const { adapter, events, waitFor } = make('');
  try {
    const r = await adapter.startChat({ cwd: process.cwd(), prompt: 'hi' });
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
    await adapter.startChat({ cwd: process.cwd(), prompt: 'hi' });
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

test('crash emits error and next action respawns', async () => {
  const { adapter, procs, waitFor } = make('crash');
  try {
    await adapter.startChat({ cwd: process.cwd(), prompt: 'hi' });
    const err = await waitFor((e) => e.type === 'error');
    assert.ok(err.type === 'error');
    assert.equal(err.sessionRef, 'thr_1');
    assert.equal(err.message, 'Codex stopped unexpectedly.');
    assert.equal(procs.length, 1);
    await adapter.sendMessage('thr_1', 'again');
    assert.equal(procs.length, 2);
  } finally { await adapter.dispose(); }
});

test('stop interrupts the running turn', async () => {
  const { adapter, waitFor } = make('hang');
  try {
    await adapter.startChat({ cwd: process.cwd(), prompt: 'hi' });
    await waitFor((e) => e.type === 'turn.started');
    await adapter.stop('thr_1');
    await waitFor((e) => e.type === 'stopped');
  } finally { await adapter.dispose(); }
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
