import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeAdapter, readClaudeUsage } from '../src/adapters/claude.ts';
import { claudeUsageToReading } from '../src/usage/parse.ts';

type Opts = any;
type Script = (opts: Opts, input: AsyncIterator<any>) => AsyncGenerator<any>;

/** A fake `query` whose generator runs `script`; records every call's options. */
function fake(script: Script, extra: Record<string, unknown> = {}) {
  const calls: { options: Opts; interrupted: number; closed: number }[] = [];
  const query = ((params: { prompt: AsyncIterable<any>; options: Opts }) => {
    const rec = { options: params.options, interrupted: 0, closed: 0 };
    calls.push(rec);
    const gen: any = script(params.options, params.prompt[Symbol.asyncIterator]());
    gen.interrupt = async () => { rec.interrupted++; };
    gen.close = () => { rec.closed++; gen.return(undefined).catch(() => {}); };
    Object.assign(gen, extra);
    return gen;
  }) as any;
  return { query, calls };
}
const init = (id = 'sess-1') => ({ type: 'system', subtype: 'init', session_id: id });
const text = (t: string) => ({ type: 'assistant', session_id: 's', message: { id: 'm1', content: [{ type: 'text', text: t }] } });
const result = (over = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's', ...over });
const never = () => new Promise<never>(() => {});
function collect(a: ClaudeAdapter) { const ev: any[] = []; a.onEvent((e) => ev.push(e)); return ev; }
const tick = () => new Promise((r) => setTimeout(r, 10));

test('startChat passes options and resolves with the init session id', async () => {
  const f = fake(async function* (_o, input) { await input.next(); yield init('abc'); await never(); });
  const a = new ClaudeAdapter({ claudePath: 'C:\\x\\claude.exe', query: f.query });
  const ev = collect(a);
  const r = await a.startChat({ cwd: 'C:\\proj', prompt: 'hi', model: 'sonnet' });
  assert.equal(r.sessionRef, 'abc');
  const o = f.calls[0]!.options;
  assert.equal(o.pathToClaudeCodeExecutable, 'C:\\x\\claude.exe');
  assert.equal(o.cwd, 'C:\\proj');
  assert.equal(o.model, 'sonnet');
  assert.equal(o.permissionMode, 'default');
  assert.equal(o.resume, undefined);
  assert.deepEqual(ev, [{ type: 'session.started', sessionRef: 'abc' }]);
  await a.dispose();
});

test('claudePath that is a .cmd shim resolves to the real exe', { skip: process.platform !== 'win32' && 'npm .cmd shims exist only on Windows' }, async () => {
  const shim = fileURLToPath(new URL('./fixtures/shims/claude.cmd', import.meta.url));
  const f = fake(async function* (_o, input) { await input.next(); yield init(); await never(); });
  const a = new ClaudeAdapter({ claudePath: shim, query: f.query });
  await a.startChat({ cwd: '.', prompt: 'x' });
  assert.equal(f.calls[0]!.options.pathToClaudeCodeExecutable,
    path.win32.join(path.win32.dirname(shim), 'node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'));
  await a.dispose();
});

test('maps assistant text, tool_use and result to events', async () => {
  const f = fake(async function* (_o, input) {
    await input.next();
    yield init();
    yield { type: 'assistant', session_id: 's', message: { id: 'm1', content: [
      { type: 'text', text: 'Working' },
      { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'signup.tsx' } },
      { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } },
      { type: 'tool_use', id: 't3', name: 'Read', input: { file_path: 'a.ts' } },
      { type: 'tool_use', id: 't4', name: 'Grep', input: {} },
    ] } };
    yield result();
    await never();
  });
  const a = new ClaudeAdapter({ claudePath: 'c', query: f.query });
  const ev = collect(a);
  await a.startChat({ cwd: '.', prompt: 'go' });
  await tick();
  const types = ev.map((e) => e.type);
  assert.deepEqual(types, ['session.started', 'turn.started', 'message.completed', 'tool.call', 'tool.call', 'tool.call', 'tool.call', 'turn.completed']);
  assert.equal(ev[2].text, 'Working');
  assert.deepEqual(ev.slice(3, 7).map((e) => e.summary), ['Editing signup.tsx', 'Running npm test', 'Reading a.ts', 'Grep']);
  assert.equal(ev[3].toolCallId, 't1');
  await a.dispose();
});

test('is_error result becomes an error event', async () => {
  const f = fake(async function* (_o, input) { await input.next(); yield init(); yield result({ subtype: 'error_during_execution', is_error: true, result: undefined }); await never(); });
  const a = new ClaudeAdapter({ claudePath: 'c', query: f.query });
  const ev = collect(a);
  await a.startChat({ cwd: '.', prompt: 'go' });
  await tick();
  assert.equal(ev.at(-1).type, 'error');
  assert.ok(ev.at(-1).message.length > 0);
  await a.dispose();
});

test('deny resolves canUseTool with the declined message', async () => {
  let outcome: any;
  const f = fake(async function* (o, input) {
    await input.next(); yield init();
    outcome = await o.canUseTool('Bash', { command: 'npm test' }, { signal: new AbortController().signal });
    yield result(); await never();
  });
  const a = new ClaudeAdapter({ claudePath: 'c', query: f.query });
  const ev = collect(a);
  const { sessionRef } = await a.startChat({ cwd: '.', prompt: 'go' });
  await tick();
  const req = ev.find((e) => e.type === 'request.opened');
  assert.equal(req.kind, 'permission');
  assert.equal(req.summary, 'Running npm test');
  await a.respondToRequest(sessionRef, req.requestId, 'deny');
  await tick();
  assert.deepEqual(outcome, { behavior: 'deny', message: 'The user declined.' });
  await a.dispose();
});

test('allow returns the input; AskUserQuestion reply fills answers; reply on other tools denies', async () => {
  const outcomes: any[] = [];
  const f = fake(async function* (o, input) {
    await input.next(); yield init();
    const sig = { signal: new AbortController().signal };
    outcomes.push(await o.canUseTool('Bash', { command: 'ls' }, sig));
    outcomes.push(await o.canUseTool('AskUserQuestion', { questions: [{ question: 'Which db?' }] }, sig));
    outcomes.push(await o.canUseTool('Write', { file_path: 'x' }, sig));
    await never();
  });
  const a = new ClaudeAdapter({ claudePath: 'c', query: f.query });
  const ev = collect(a);
  const { sessionRef } = await a.startChat({ cwd: '.', prompt: 'go' });
  const next = async () => { await tick(); return ev.filter((e) => e.type === 'request.opened').at(-1); };
  await a.respondToRequest(sessionRef, (await next()).requestId, 'allow');
  const q = await next();
  assert.equal(q.kind, 'question');
  assert.equal(q.summary, 'Which db?');
  await a.respondToRequest(sessionRef, q.requestId, { reply: 'postgres' });
  await a.respondToRequest(sessionRef, (await next()).requestId, { reply: 'no thanks' });
  await tick();
  assert.deepEqual(outcomes[0], { behavior: 'allow', updatedInput: { command: 'ls' } });
  assert.deepEqual(outcomes[1], { behavior: 'allow', updatedInput: { questions: [{ question: 'Which db?' }], answers: { 'Which db?': 'postgres' } } });
  assert.deepEqual(outcomes[2], { behavior: 'deny', message: 'no thanks' });
  await a.dispose();
});

test('aborted canUseTool drops the pending request', async () => {
  const ac = new AbortController();
  const f = fake(async function* (o, input) {
    await input.next(); yield init();
    void o.canUseTool('Bash', { command: 'ls' }, { signal: ac.signal });
    await never();
  });
  const a = new ClaudeAdapter({ claudePath: 'c', query: f.query });
  const ev = collect(a);
  const { sessionRef } = await a.startChat({ cwd: '.', prompt: 'go' });
  await tick();
  const req = ev.find((e) => e.type === 'request.opened');
  ac.abort();
  assert.equal((a as any).chats.get(sessionRef).pending.size, 0);
  await a.respondToRequest(sessionRef, req.requestId, 'allow'); // no throw
  await a.dispose();
});

test('resume passes resume: sessionRef and the cwd', async () => {
  const f = fake(async function* () { await never(); });
  const a = new ClaudeAdapter({ claudePath: 'c', query: f.query });
  await a.resume('old-session', 'C:\\proj');
  assert.equal(f.calls[0]!.options.resume, 'old-session');
  assert.equal(f.calls[0]!.options.cwd, 'C:\\proj');
  await a.dispose();
});

test('sendMessage pushes to the live query; a dead query restarts with resume', async () => {
  const seen: string[] = [];
  let n = 0;
  const f = fake(async function* (_o, input) {
    const mine = ++n;
    for (;;) {
      const m = await input.next();
      if (m.done) return;
      seen.push(`${mine}:${m.value.message.content}`);
      if (mine === 1 && seen.length === 1) yield init('s1');
      if (mine === 1 && seen.length === 2) throw new Error('process died');
      if (mine === 2) { yield result(); }
    }
  });
  const a = new ClaudeAdapter({ claudePath: 'c', query: f.query });
  const ev = collect(a);
  const { sessionRef } = await a.startChat({ cwd: 'C:\\p', prompt: 'one' });
  await a.sendMessage(sessionRef, 'two');
  await tick();
  assert.deepEqual(ev.filter((e) => e.type === 'error'), [{ type: 'error', sessionRef: 's1', message: 'Claude Code stopped unexpectedly.' }]);
  assert.equal(f.calls.length, 1);
  await a.sendMessage(sessionRef, 'three');
  await tick();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1]!.options.resume, 's1');
  assert.equal(f.calls[1]!.options.cwd, 'C:\\p');
  assert.deepEqual(seen, ['1:one', '1:two', '2:three']);
  assert.equal(ev.at(-1).type, 'turn.completed');
  await a.dispose();
});

test('stop interrupts and emits stopped without a trailing error', async () => {
  const f = fake(async function* (_o, input) {
    await input.next(); yield init('s1'); yield text('thinking');
    await tick();
    yield result({ subtype: 'error_during_execution', is_error: true });
    await never();
  });
  const a = new ClaudeAdapter({ claudePath: 'c', query: f.query });
  const ev = collect(a);
  const { sessionRef } = await a.startChat({ cwd: '.', prompt: 'go' });
  await tick();
  await a.stop(sessionRef);
  assert.equal(f.calls[0]!.interrupted, 1);
  await tick(); await tick();
  assert.equal(ev.filter((e) => e.type === 'stopped').length, 1);
  assert.equal(ev.filter((e) => e.type === 'error').length, 0);
  await a.dispose();
});

test('dispose closes queries, clears listeners and rejects later actions', async () => {
  const f = fake(async function* (_o, input) { await input.next(); yield init(); await never(); });
  const a = new ClaudeAdapter({ claudePath: 'c', query: f.query });
  const ev = collect(a);
  const { sessionRef } = await a.startChat({ cwd: '.', prompt: 'go' });
  await a.dispose();
  assert.equal(f.calls[0]!.closed, 1);
  await assert.rejects(a.sendMessage(sessionRef, 'x'), /Claude Code adapter is shut down\./);
  await assert.rejects(a.startChat({ cwd: '.', prompt: 'x' }), /Claude Code adapter is shut down\./);
  assert.equal(ev.length, 1);
});

const usageFixture = {
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 28, resets_at: '2026-10-22T14:40:00Z' },
    seven_day: { utilization: 42, resets_at: '2026-10-23T09:00:00Z' },
    seven_day_opus: { utilization: 66, resets_at: null },
  },
};

test('readClaudeUsage maps the usage response and skips behaviors', async () => {
  let arg: any;
  const q: any = { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async (o: any) => { arg = o; return usageFixture; } };
  const r = await readClaudeUsage(q);
  assert.deepEqual(arg, { skipBehaviors: true });
  assert.deepEqual(r.windows, claudeUsageToReading(usageFixture as any, new Date()).windows);
});

test('readUsage with no live chat uses the shared usage query', async () => {
  const f = fake(async function* () { await never(); }, { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => usageFixture });
  const a = new ClaudeAdapter({ claudePath: 'c', query: f.query });
  const r = await a.readUsage();
  assert.equal(r.provider, 'claude');
  assert.equal(r.status, 'ok');
  assert.equal(r.windows.length, 3);
  assert.equal(f.calls[0]!.closed, 0);
  await a.dispose();
});

test('readUsage failure becomes an error reading', async () => {
  const f = fake(async function* () { await never(); }, { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => { throw new Error('boom'); } });
  const a = new ClaudeAdapter({ claudePath: 'c', query: f.query });
  const r = await a.readUsage();
  assert.equal(r.status, 'error');
  assert.equal(r.message, "Couldn't read Claude Code usage.");
  await a.dispose();
});

// ---- fix round 1 ----
const USAGE = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET';

test('dispose during an in-flight startChat rejects it, closes the query, emits nothing after', async () => {
  const f = fake(async function* (_o, input) { await input.next(); await never(); });
  const a = new ClaudeAdapter({ claudePath: 'c', query: f.query });
  const ev = collect(a);
  const p = a.startChat({ cwd: '.', prompt: 'go' });
  const rejected = assert.rejects(p, /Claude Code adapter is shut down\./);
  await tick();
  await a.dispose();
  await rejected;
  assert.equal(f.calls[0]!.closed, 1);
  await tick();
  assert.equal((a as any).chats.size, 0);
  assert.deepEqual(ev, []);
});

test('PowerShell summary reads like a command', async () => {
  const f = fake(async function* (_o, input) {
    await input.next(); yield init();
    yield { type: 'assistant', session_id: 's', uuid: 'u1', message: { id: 'm', content: [{ type: 'tool_use', id: 't', name: 'PowerShell', input: { command: 'ls' } }] } };
    await never();
  });
  const a = new ClaudeAdapter({ claudePath: 'c', query: f.query });
  const ev = collect(a);
  await a.startChat({ cwd: '.', prompt: 'go' });
  await tick();
  assert.equal(ev.find((e) => e.type === 'tool.call').summary, 'Running ls');
  await a.dispose();
});

test('messageId uses the SDK uuid plus block index', async () => {
  const f = fake(async function* (_o, input) {
    await input.next(); yield init();
    yield { type: 'assistant', session_id: 's', uuid: 'u-9', message: { id: 'same', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } };
    await never();
  });
  const a = new ClaudeAdapter({ claudePath: 'c', query: f.query });
  const ev = collect(a);
  await a.startChat({ cwd: '.', prompt: 'go' });
  await tick();
  assert.deepEqual(ev.filter((e) => e.type === 'message.completed').map((e) => e.messageId), ['u-9:0', 'u-9:1']);
  await a.dispose();
});

test('a request that arrives before init is announced with the session id once known', async () => {
  let outcome: any;
  const f = fake(async function* (o, input) {
    await input.next();
    const p = o.canUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal });
    p.then((r: any) => { outcome = r; });
    yield init('late');
    await never();
  });
  const a = new ClaudeAdapter({ claudePath: 'c', query: f.query });
  const ev = collect(a);
  const { sessionRef } = await a.startChat({ cwd: '.', prompt: 'go' });
  await tick();
  const req = ev.find((e) => e.type === 'request.opened');
  assert.equal(req.sessionRef, 'late');
  await a.respondToRequest(sessionRef, req.requestId, 'allow');
  await tick();
  assert.equal(outcome.behavior, 'allow');
  await a.dispose();
});

test('a listener that throws does not look like a process death', async () => {
  const f = fake(async function* (_o, input) { await input.next(); yield init(); yield text('x'); yield result(); await never(); });
  const a = new ClaudeAdapter({ claudePath: 'c', query: f.query });
  a.onEvent(() => { throw new Error('bad listener'); });
  const ev = collect(a);
  await a.startChat({ cwd: '.', prompt: 'go' });
  await tick();
  assert.equal(ev.at(-1).type, 'turn.completed');
  assert.equal(ev.filter((e) => e.type === 'error').length, 0);
  await a.dispose();
});

test('startup failure: result before init settles startChat and closes the query and queue', async () => {
  const f = fake(async function* (_o, input) { await input.next(); yield result({ is_error: true, result: 'Not signed in', session_id: undefined }); await never(); });
  const a = new ClaudeAdapter({ claudePath: 'c', query: f.query });
  await assert.rejects(a.startChat({ cwd: '.', prompt: 'go' }), /Not signed in/);
  assert.equal(f.calls[0]!.closed, 1);
  assert.equal((a as any).live.size, 0);
  await a.dispose();
});

test('startup failure: iteration throwing before init settles startChat', async () => {
  const f = fake(async function* (_o, input) { await input.next(); throw new Error('spawn failed'); });
  const a = new ClaudeAdapter({ claudePath: 'c', query: f.query });
  await assert.rejects(a.startChat({ cwd: '.', prompt: 'go' }), /spawn failed/);
  assert.equal(f.calls[0]!.closed, 1);
  assert.equal((a as any).live.size, 0);
  await a.dispose();
});

test('pending requests settle on crash and on dispose', async () => {
  const outcomes: any[] = [];
  let crash!: () => void;
  const f = fake(async function* (o, input) {
    await input.next(); yield init('s1');
    void o.canUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal }).then((r: any) => outcomes.push(r));
    await new Promise<void>((r) => { crash = r; });
    throw new Error('died');
  });
  const a = new ClaudeAdapter({ claudePath: 'c', query: f.query });
  await a.startChat({ cwd: '.', prompt: 'go' });
  await tick();
  crash();
  await tick();
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].behavior, 'deny');
  assert.equal(f.calls[0]!.closed, 1);
  const f2 = fake(async function* (o, input) {
    await input.next(); yield init('s2');
    void o.canUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal }).then((r: any) => outcomes.push(r));
    await never();
  });
  const b = new ClaudeAdapter({ claudePath: 'c', query: f2.query });
  await b.startChat({ cwd: '.', prompt: 'go' });
  await tick();
  await b.dispose();
  assert.equal(outcomes.length, 2);
  await a.dispose();
});

test('readUsage reuses a live chat query', async () => {
  const f = fake(async function* (_o, input) { await input.next(); yield init(); await never(); }, { [USAGE]: async () => usageFixture });
  const a = new ClaudeAdapter({ claudePath: 'c', query: f.query });
  await a.startChat({ cwd: '.', prompt: 'go' });
  const r = await a.readUsage();
  assert.equal(r.status, 'ok');
  assert.equal(f.calls.length, 1);
  await a.dispose();
});

test('usage query is long-lived, strict about MCP, and closed by dispose', async () => {
  const f = fake(async function* () { await never(); }, { [USAGE]: async () => usageFixture });
  const a = new ClaudeAdapter({ claudePath: 'c', query: f.query });
  await a.readUsage();
  await a.readUsage();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.closed, 0);
  assert.deepEqual(f.calls[0]!.options.mcpServers, {});
  assert.equal(f.calls[0]!.options.strictMcpConfig, true);
  await a.dispose();
  assert.equal(f.calls[0]!.closed, 1);
  await assert.rejects(a.readUsage(), /Claude Code adapter is shut down\./);
});

test('usage timeout returns an error reading, closes the query, next read creates a new one', async () => {
  let hang = true;
  const f = fake(async function* () { await never(); }, { [USAGE]: () => (hang ? never() : Promise.resolve(usageFixture)) });
  const a = new ClaudeAdapter({ claudePath: 'c', query: f.query, usageTimeoutMs: 30 });
  const r = await a.readUsage();
  assert.equal(r.status, 'error');
  assert.equal(r.message, "Couldn't read Claude Code usage.");
  assert.equal(f.calls[0]!.closed, 1);
  hang = false;
  assert.equal((await a.readUsage()).status, 'ok');
  assert.equal(f.calls.length, 2);
  await a.dispose();
});

// ---- Task 10: ping and usage-query draining ----
test('ping reads accountInfo from the shared query and maps tokenSource to signedIn', async () => {
  let info: any = { tokenSource: 'claude.ai' };
  const f = fake(async function* () { await never(); }, { accountInfo: async () => info });
  const a = new ClaudeAdapter({ claudePath: 'c', query: f.query });
  assert.deepEqual(await a.ping(), { ok: true, signedIn: true });
  info = { tokenSource: 'none' };
  assert.deepEqual(await a.ping(), { ok: true, signedIn: false });
  info = {};
  assert.deepEqual(await a.ping(), { ok: true, signedIn: false });
  info = { email: 'a@b.c', subscriptionType: 'Claude Pro' }; // real Claude Code 2.1.308 reply: no tokenSource
  assert.deepEqual(await a.ping(), { ok: true, signedIn: true });
  info = { tokenSource: 'none', email: 'a@b.c' };
  assert.deepEqual(await a.ping(), { ok: true, signedIn: false });
  await a.dispose();
});

test('ping failure backs off 1 s, 2 s, 4 s before the shared query is recreated; a manual ping skips the wait', async () => {
  mock.timers.enable({ apis: ['Date'], now: 0 });
  let hang = true;
  const f = fake(async function* () { await never(); }, { accountInfo: () => (hang ? never() : Promise.resolve({ tokenSource: 'claude.ai' })) });
  const a = new ClaudeAdapter({ claudePath: 'c', query: f.query, usageTimeoutMs: 30 });
  try {
    assert.equal((await a.ping()).ok, false);
    assert.equal(f.calls[0]!.closed, 1);
    assert.equal((await a.ping()).ok, false);
    assert.equal(f.calls.length, 1, 'no new query inside the 1 s backoff');
    mock.timers.tick(1000);
    assert.equal((await a.ping()).ok, false);
    assert.equal(f.calls.length, 2);
    mock.timers.tick(1999);
    await a.ping();
    assert.equal(f.calls.length, 2, 'second gap is 2 s');
    mock.timers.tick(1);
    await a.ping();
    assert.equal(f.calls.length, 3);
    hang = false;
    assert.deepEqual(await a.ping({ manual: true }), { ok: true, signedIn: true });
    assert.equal(f.calls.length, 4);
  } finally { mock.timers.reset(); await a.dispose(); }
});

test('ping never borrows a live chat query', async () => {
  const f = fake(async function* (_o, input) { await input.next(); yield init(); await never(); }, { accountInfo: async () => ({ tokenSource: 'claude.ai' }) });
  const a = new ClaudeAdapter({ claudePath: 'c', query: f.query });
  await a.startChat({ cwd: '.', prompt: 'hi' });
  assert.equal((await a.ping()).ok, true);
  assert.equal(f.calls.length, 2, 'the chat query plus a separate shared one');
  await a.dispose();
});

test('after a signed-out result, and on a manual check, ping starts from a fresh query', async () => {
  let info: any = { tokenSource: 'none' };
  const f = fake(async function* () { await never(); }, { accountInfo: async () => info });
  const a = new ClaudeAdapter({ claudePath: 'c', query: f.query });
  assert.equal((await a.ping()).signedIn, false);
  info = { tokenSource: 'claude.ai' };
  assert.equal((await a.ping()).signedIn, true, 'the new sign-in is seen');
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0]!.closed, 1);
  await a.ping();
  assert.equal(f.calls.length, 2, 'signed in: the query is reused');
  await a.ping({ manual: true });
  assert.equal(f.calls.length, 3);
  assert.equal(await a.restartIfIdle(), true);
  assert.equal(f.calls[2]!.closed, 1);
  await a.dispose();
});

test('the shared usage query is drained in the background and draining stops once it is closed', async () => {
  let yielded = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const f = fake(async function* () {
    for (let i = 0; i < 5; i++) { yielded++; yield { type: 'noise' }; }
    await gate;
    for (let i = 0; i < 5; i++) { yielded++; yield { type: 'noise' }; }
  }, { [USAGE]: () => never(), accountInfo: async () => ({ tokenSource: 'claude.ai' }) });
  const a = new ClaudeAdapter({ claudePath: 'c', query: f.query, usageTimeoutMs: 30 });
  await a.ping();
  await tick();
  assert.equal(yielded, 5, 'messages are consumed without anyone asking');
  await a.readUsage(); // times out, which closes the shared query
  assert.equal(f.calls[0]!.closed, 1);
  release();
  await tick();
  assert.ok(yielded <= 6, `draining stopped after close (yielded ${yielded})`);
  await a.dispose();
});

test('readUsage does not recreate the shared query inside the ping backoff window', async () => {
  mock.timers.enable({ apis: ['Date'], now: 0 });
  const f = fake(async function* () { await never(); }, { accountInfo: () => never(), [USAGE]: async () => usageFixture });
  const a = new ClaudeAdapter({ claudePath: 'c', query: f.query, usageTimeoutMs: 30 });
  try {
    assert.equal((await a.ping()).ok, false);
    assert.equal(f.calls.length, 1);
    const r = await a.readUsage();
    assert.equal(r.status, 'error');
    assert.equal(f.calls.length, 1, 'no spawn inside the window');
    mock.timers.tick(1000);
    assert.equal((await a.readUsage()).status, 'ok');
    assert.equal(f.calls.length, 2);
  } finally { mock.timers.reset(); await a.dispose(); }
});

test('a manual ping while readUsage is in flight does not break that read', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const f = fake(async function* () { await never(); }, {
    accountInfo: async () => ({ tokenSource: 'claude.ai' }),
    [USAGE]: async () => { await gate; return usageFixture; },
  });
  const a = new ClaudeAdapter({ claudePath: 'c', query: f.query });
  const reading = a.readUsage();
  await tick();
  await a.ping({ manual: true }); // replaces the shared query on purpose
  assert.equal(f.calls[0]!.closed, 0, 'the old query stays open until the read finishes');
  release();
  assert.equal((await reading).status, 'ok');
  assert.equal(f.calls[0]!.closed, 1);
  await a.dispose();
});

test('an AskUserQuestion reply answers every question, keyed by the question text', async () => {
  let outcome: any;
  const f = fake(async function* (o, input) {
    await input.next(); yield init();
    outcome = await o.canUseTool('AskUserQuestion', { questions: [{ question: 'Name?', header: 'n' }, { question: 'Size?' }] }, { signal: new AbortController().signal });
    await never();
  });
  const a = new ClaudeAdapter({ claudePath: 'c', query: f.query });
  const ev = collect(a);
  const { sessionRef } = await a.startChat({ cwd: '.', prompt: 'go' });
  await tick();
  await a.respondToRequest(sessionRef, ev.find((e) => e.type === 'request.opened').requestId, { reply: 'a.txt' });
  await tick();
  assert.deepEqual(outcome.updatedInput.answers, { 'Name?': 'a.txt', 'Size?': 'a.txt' });
  assert.deepEqual(outcome.updatedInput.questions, [{ question: 'Name?', header: 'n' }, { question: 'Size?' }]);
  await a.dispose();
});

/** Each message on the prompt stream is one turn: init, a reply, then a result. */
const turns = (seen: string[] = []) => fake(async function* (_o, input) {
  for (;;) {
    const m = await input.next();
    if (m.done) return;
    seen.push(m.value.message.content);
    yield init('abc');
    yield text(`re: ${m.value.message.content}`);
    yield result();
  }
});
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

test('an idle chat query is closed after 10 minutes without any event; the next message resumes it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const seen: string[] = [];
  const f = turns(seen);
  const a = new ClaudeAdapter({ claudePath: 'c', query: f.query, idleCloseMs: 600_000 });
  const ev = collect(a);
  const { sessionRef } = await a.startChat({ cwd: 'C:\\p', prompt: 'one' });
  await settle();
  assert.equal(ev.filter((e) => e.type === 'turn.completed').length, 1);
  t.mock.timers.tick(599_999); await settle();
  assert.equal(f.calls[0]!.closed, 0, 'not before 10 minutes');
  const before = ev.length;
  t.mock.timers.tick(1); await settle();
  assert.equal(f.calls[0]!.closed, 1, 'closed after 10 idle minutes');
  assert.equal(ev.length, before, 'closing an idle query emits nothing');
  await a.sendMessage(sessionRef, 'two');
  await settle();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1]!.options.resume, 'abc');
  assert.deepEqual(seen, ['one', 'two']);
  assert.equal(ev.filter((e) => e.type === 'turn.completed').length, 2);
  await a.dispose();
});

test('a running turn or a pending request keeps an idle chat query open', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // Turn 1 completes; a second message starts a turn that never finishes.
  let n = 0;
  const f = fake(async function* (_o, input) {
    for (;;) {
      const m = await input.next();
      if (m.done) return;
      n++;
      yield init('abc');
      if (n === 1) yield result();
    }
  });
  const a = new ClaudeAdapter({ claudePath: 'c', query: f.query, idleCloseMs: 600_000 });
  const { sessionRef } = await a.startChat({ cwd: '.', prompt: 'one' });
  await settle();
  await a.sendMessage(sessionRef, 'two');
  await settle();
  t.mock.timers.tick(30 * 60_000); await settle();
  assert.equal(f.calls[0]!.closed, 0, 'a running turn is never closed');
  await a.dispose();

  // A request left open after the result also keeps it.
  const g = fake(async function* (o, input) {
    await input.next(); yield init('abc'); yield result();
    void o.canUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal });
    await never();
  });
  const b = new ClaudeAdapter({ claudePath: 'c', query: g.query, idleCloseMs: 600_000 });
  await b.startChat({ cwd: '.', prompt: 'one' });
  await settle();
  t.mock.timers.tick(30 * 60_000); await settle();
  assert.equal(g.calls[0]!.closed, 0, 'a pending request is never closed');
  await b.dispose();
});

test('listModels inside the ping backoff returns [] without creating a query', async () => {
  mock.timers.enable({ apis: ['Date'], now: 0 });
  const f = fake(async function* () { await never(); }, { accountInfo: () => never(), supportedModels: async () => [{ value: 'default', displayName: 'Default' }] });
  const a = new ClaudeAdapter({ claudePath: 'c', query: f.query, usageTimeoutMs: 30 });
  try {
    assert.equal((await a.ping()).ok, false);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(await a.listModels(), []);
    assert.equal(f.calls.length, 1, 'no new query inside the window');
    mock.timers.tick(1000);
    assert.equal((await a.listModels()).length, 1);
  } finally { mock.timers.reset(); await a.dispose(); }
});

test('a listModels failure backs off like a failed ping', async () => {
  mock.timers.enable({ apis: ['Date'], now: 0 });
  const f = fake(async function* () { await never(); }, { supportedModels: () => never() });
  const a = new ClaudeAdapter({ claudePath: 'c', query: f.query, usageTimeoutMs: 30 });
  try {
    await assert.rejects(a.listModels());
    assert.equal(f.calls.length, 1);
    assert.deepEqual(await a.listModels(), []);
    assert.equal(f.calls.length, 1, 'not recreated inside the backoff');
  } finally { mock.timers.reset(); await a.dispose(); }
});
