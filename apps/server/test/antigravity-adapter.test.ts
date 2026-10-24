import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdapterEvent } from '@agent-kanban/shared';
import { AntigravityAdapter } from '../src/adapters/antigravity.ts';
import { JsonRpcProcess } from '../src/adapters/jsonrpc.ts';
import { ConnectionMonitor } from '../src/health.ts';

const fake = fileURLToPath(new URL('./fixtures/fake-acp-server.ts', import.meta.url));
const cwd = process.cwd();
const noSettings = mkdtempSync(join(tmpdir(), 'ak-gemini-none-'));

function make(scenario: string | ((n: number) => string), env: Record<string, string> = {}, opts: { geminiHome?: string; pingTimeoutMs?: number } = {}) {
  const procs: JsonRpcProcess[] = [];
  const adapter = new AntigravityAdapter({
    exePath: 'unused',
    geminiHome: opts.geminiHome ?? noSettings,
    pingTimeoutMs: opts.pingTimeoutMs ?? 5_000,
    spawn: () => {
      const sc = typeof scenario === 'string' ? scenario : scenario(procs.length);
      const p = new JsonRpcProcess(process.execPath, ['--disable-warning=ExperimentalWarning', fake], {
        env: { ...process.env, FAKE_SCENARIO: sc, ...env }, jsonrpc: '2.0', requestTimeoutMs: 10_000,
      });
      procs.push(p);
      return p;
    },
  });
  const events: AdapterEvent[] = [];
  adapter.onEvent((e) => events.push(e));
  const waitFor = async (pred: (e: AdapterEvent) => boolean, from = 0) => {
    for (let i = 0; i < 800; i++) {
      const hit = events.slice(from).find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('timed out; events: ' + JSON.stringify(events));
  };
  return { adapter, procs, events, waitFor };
}

test('a turn maps to session.started, turn.started, deltas, tool calls, message.completed, turn.completed', async () => {
  const { adapter, events, waitFor } = make('turn');
  try {
    const r = await adapter.startChat({ cwd, prompt: 'hi' });
    assert.deepEqual(r, { sessionRef: 'sess_1' });
    await waitFor((e) => e.type === 'turn.completed');
    assert.deepEqual(events.map((e) => e.type), [
      'session.started', 'turn.started', 'message.delta', 'message.delta', 'tool.call', 'tool.call', 'message.completed', 'turn.completed',
    ]);
    const deltas = events.filter((e) => e.type === 'message.delta');
    const done = events.find((e) => e.type === 'message.completed');
    assert.ok(done?.type === 'message.completed');
    assert.equal(done.text, 'Hello world');
    assert.ok(deltas.every((d) => d.type === 'message.delta' && d.messageId === done.messageId));
    const tools = events.filter((e) => e.type === 'tool.call');
    assert.deepEqual(tools.map((t) => t.type === 'tool.call' && [t.toolCallId, t.name, t.summary, t.status]), [
      ['call_1', 'read', 'Read a.txt', 'running'],
      ['call_1', 'read', 'Read a.txt', 'done'],
    ]);
  } finally { await adapter.dispose(); }
});

test('a second turn gets a new message id', async () => {
  const { adapter, events, waitFor } = make('turn');
  try {
    await adapter.startChat({ cwd, prompt: 'hi' });
    await waitFor((e) => e.type === 'turn.completed');
    const n = events.length;
    await adapter.sendMessage('sess_1', 'again');
    await waitFor((e) => e.type === 'turn.completed', n);
    const ids = new Set(events.filter((e) => e.type === 'message.completed').map((e) => e.type === 'message.completed' && e.messageId));
    assert.equal(ids.size, 2);
  } finally { await adapter.dispose(); }
});

for (const reason of ['refusal', 'max_tokens'] as const) {
  test(`stop reason ${reason} ends the turn as turn.completed`, async () => {
    const { adapter, events, waitFor } = make('turn', { FAKE_STOP: reason });
    try {
      await adapter.startChat({ cwd, prompt: 'hi' });
      await waitFor((e) => e.type === 'turn.completed');
      assert.ok(!events.some((e) => e.type === 'stopped' || e.type === 'error'));
    } finally { await adapter.dispose(); }
  });
}

for (const [decision, expected] of [
  ['allow', 'permission: allow_once'],
  ['deny', 'permission: reject_once'],
  [{ reply: 'no, use pnpm' }, 'permission: reject_once'],
] as const) {
  test(`permission request opens and ${typeof decision === 'string' ? decision : 'a reply'} answers ${expected.split(' ')[1]}`, async () => {
    const { adapter, events, waitFor } = make('permission');
    try {
      await adapter.startChat({ cwd, prompt: 'run tests' });
      const req = await waitFor((e) => e.type === 'request.opened');
      assert.ok(req.type === 'request.opened');
      assert.equal(req.kind, 'permission');
      assert.equal(req.summary, 'Run npm test');
      assert.ok(!events.some((e) => e.type === 'turn.completed'));
      await adapter.respondToRequest('sess_1', req.requestId, decision);
      const done = await waitFor((e) => e.type === 'message.completed');
      assert.ok(done.type === 'message.completed');
      assert.equal(done.text, expected);
      await waitFor((e) => e.type === 'turn.completed');
    } finally { await adapter.dispose(); }
  });
}

test('stop cancels the turn: stopped, not turn.completed', async () => {
  const { adapter, events, waitFor } = make('cancel');
  try {
    await adapter.startChat({ cwd, prompt: 'long job' });
    await waitFor((e) => e.type === 'message.delta');
    await adapter.stop('sess_1');
    await waitFor((e) => e.type === 'stopped');
    assert.ok(!events.some((e) => e.type === 'turn.completed'));
    const done = events.find((e) => e.type === 'message.completed');
    assert.ok(done?.type === 'message.completed' && done.text === 'Working');
  } finally { await adapter.dispose(); }
});

test('stop while a permission is open answers it cancelled and ends stopped', async () => {
  const { adapter, waitFor } = make('permcancel');
  try {
    await adapter.startChat({ cwd, prompt: 'run tests' });
    await waitFor((e) => e.type === 'request.opened');
    await adapter.stop('sess_1');
    await waitFor((e) => e.type === 'stopped');
  } finally { await adapter.dispose(); }
});

test('a crash mid-turn emits "Antigravity stopped unexpectedly." and the next send restarts it', async () => {
  const { adapter, procs, events, waitFor } = make((n) => (n === 0 ? 'crash' : 'turn'), { FAKE_LOADABLE: 'sess_1' });
  try {
    await adapter.startChat({ cwd, prompt: 'hi' });
    const err = await waitFor((e) => e.type === 'error');
    assert.ok(err.type === 'error');
    assert.equal(err.message, 'Antigravity stopped unexpectedly.');
    assert.equal(events.filter((e) => e.type === 'error').length, 1, 'reported once');
    const n = events.length;
    await adapter.sendMessage('sess_1', 'again');
    await waitFor((e) => e.type === 'turn.completed', n);
    assert.equal(procs.length, 2);
    // the load's history replay is not shown as a new message
    assert.ok(!events.slice(n).some((e) => e.type === 'message.delta' && e.text === 'replayed'));
  } finally { await adapter.dispose(); }
});

test('resume loads the session with session/load, and an unknown one rejects', async () => {
  const { adapter, events, waitFor } = make('turn');
  try {
    await adapter.resume('sess_old', cwd);
    assert.ok(!events.some((e) => e.type === 'message.delta'), 'replayed history is not a new message');
    await adapter.sendMessage('sess_old', 'continue');
    await waitFor((e) => e.type === 'turn.completed');
    await assert.rejects(adapter.resume('conv-from-the-ide', cwd), /not found/);
  } finally { await adapter.dispose(); }
});

test('sending while a turn runs is refused', async () => {
  const { adapter, waitFor } = make('cancel');
  try {
    await adapter.startChat({ cwd, prompt: 'long job' });
    await waitFor((e) => e.type === 'message.delta');
    await assert.rejects(adapter.sendMessage('sess_1', 'more'), /still working/);
    await adapter.stop('sess_1');
    await waitFor((e) => e.type === 'stopped');
  } finally { await adapter.dispose(); }
});

test('startChat when signed out rejects with "isn\'t signed in"', async () => {
  const { adapter } = make('signin');
  try {
    await assert.rejects(adapter.startChat({ cwd, prompt: 'hi' }), /Antigravity isn't signed in\./);
    assert.equal((await adapter.ping()).signedIn, false);
  } finally { await adapter.dispose(); }
});

test('signIn passes the link once and resolves when the agent reports the sign-in finished', async () => {
  const { adapter } = make('signin');
  try {
    assert.deepEqual(await adapter.ping(), { ok: true, signedIn: false });
    const urls: string[] = [];
    await adapter.signIn((u) => urls.push(u), new AbortController().signal);
    assert.equal(urls.length, 1);
    assert.match(urls[0], /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
    assert.deepEqual(await adapter.ping(), { ok: true, signedIn: true });
    assert.deepEqual(await adapter.startChat({ cwd, prompt: 'hi' }), { sessionRef: 'sess_1' });
  } finally { await adapter.dispose(); }
});

test('signIn finds the link on stderr (where the real agent prints it)', async () => {
  const { adapter } = make('signin', { FAKE_AUTH_STREAM: 'stderr', FAKE_AUTH_HANG: '1' });
  const ac = new AbortController();
  try {
    const urls: string[] = [];
    const p = adapter.signIn((u) => { urls.push(u); }, ac.signal);
    for (let i = 0; i < 500 && urls.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(urls.length, 1);
    ac.abort();
    await assert.rejects(p, (e: any) => e.name === 'AbortError');
  } finally { await adapter.dispose(); }
});

test('cancelling signIn stops the agent process; the next action starts a new one', async () => {
  const { adapter, procs } = make('signin', { FAKE_AUTH_HANG: '1' });
  const ac = new AbortController();
  try {
    const p = adapter.signIn(() => ac.abort(), ac.signal);
    await assert.rejects(p, (e: any) => e.name === 'AbortError');
    let exited = false;
    procs[0]!.onExit(() => { exited = true; });
    for (let i = 0; i < 500 && !exited; i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(exited, 'the sign-in process was stopped');
    assert.equal((await adapter.ping({ manual: true })).ok, true);
    assert.equal(procs.length, 2);
  } finally { await adapter.dispose(); }
});

test('signIn when already signed in resolves at once without a link', async () => {
  const { adapter } = make('ready');
  try {
    const urls: string[] = [];
    await adapter.signIn((u) => urls.push(u), new AbortController().signal);
    assert.deepEqual(urls, []);
  } finally { await adapter.dispose(); }
});

test('without an authenticated flag (real agent), signed in follows settings.json auth.type', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ak-gemini-'));
  const { adapter } = make('ready', { FAKE_NO_AUTH_FLAG: '1' }, { geminiHome: home });
  try {
    assert.equal((await adapter.ping()).signedIn, false);
    mkdirSync(join(home, 'antigravity-acp'), { recursive: true });
    writeFileSync(join(home, 'antigravity-acp', 'settings.json'), JSON.stringify({ auth: { type: 'oauth-personal' } }));
    assert.equal((await adapter.ping()).signedIn, true);
  } finally { await adapter.dispose(); }
});

test('a sign-in link nobody asked for (the login is gone): startChat says signed out and the agent is restarted', async () => {
  const { adapter, procs } = make('ready', { FAKE_NEW_SIGNIN: '1' });
  try {
    await assert.rejects(adapter.startChat({ cwd, prompt: 'hi' }), /Antigravity isn't signed in\./);
    let exited = false;
    procs[0]!.onExit(() => { exited = true; });
    for (let i = 0; i < 500 && !exited; i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(exited, 'the agent running the unasked sign-in was stopped');
  } finally { await adapter.dispose(); }
});

test('readUsage is unavailable with the plan copy, listModels is empty, and neither starts the agent', async () => {
  const { adapter, procs } = make('ready');
  try {
    const u = await adapter.readUsage();
    assert.equal(u.status, 'unavailable');
    assert.equal(u.provider, 'antigravity');
    assert.equal(u.message, "Antigravity doesn't report its limits.");
    assert.deepEqual(await adapter.listModels(), []);
    assert.equal(procs.length, 0);
  } finally { await adapter.dispose(); }
});

test('agentVersion is the ACP agentInfo.version', async () => {
  const { adapter } = make('ready');
  try { assert.equal(await adapter.agentVersion(), '1.3.0'); } finally { await adapter.dispose(); }
});

test('health shows signed_out before sign-in and connected after', async () => {
  const { adapter } = make('signin');
  const monitor = new ConnectionMonitor({
    providers: ['antigravity'],
    findBinary: async () => 'agy',
    getVersion: async () => adapter.agentVersion(),
    getLatest: async () => '1.3.0',
    adapters: { ensure: async () => adapter },
    onUpdate: () => {},
  });
  try {
    const [before] = await monitor.check('antigravity');
    assert.equal(before!.status, 'signed_out');
    assert.equal(before!.version, '1.3.0');
    await adapter.signIn(() => {}, new AbortController().signal);
    const [after] = await monitor.check('antigravity');
    assert.equal(after!.status, 'connected');
  } finally { monitor.stop(); await adapter.dispose(); }
});
