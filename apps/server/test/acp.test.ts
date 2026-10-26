import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JsonRpcProcess } from '../src/adapters/jsonrpc.ts';
import { AcpClient, parseAuthUrl } from '../src/adapters/acp.ts';

const fake = fileURLToPath(new URL('./fixtures/fake-acp-server.ts', import.meta.url));

function start(scenario: string, extraEnv: Record<string, string> = {}) {
  const proc = new JsonRpcProcess(process.execPath, [fake], {
    env: { ...process.env, FAKE_SCENARIO: scenario, ...extraEnv },
    jsonrpc: '2.0',
    requestTimeoutMs: 10_000,
  });
  return { proc, acp: new AcpClient(proc) };
}

const GOOD = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=http%3A%2F%2F127.0.0.1%3A51234%2F';

test('outgoing messages carry "jsonrpc":"2.0" only when asked', async () => {
  const { proc } = start('ready');
  const plain = new JsonRpcProcess(process.execPath, [fake], { env: { ...process.env, FAKE_SCENARIO: 'ready' } });
  try {
    const echoed = await proc.request<any>('test/echo', { a: 1 });
    assert.equal(echoed.jsonrpc, '2.0');
    assert.deepEqual(echoed.params, { a: 1 });
    // the default (Codex) framing is unchanged: no "jsonrpc" field, so the strict fake refuses it
    await assert.rejects(plain.request('test/echo', {}), /missing jsonrpc/);
  } finally { await proc.close(); await plain.close(); }
});

test('initialize sends the client capabilities and parses agentInfo and auth', async () => {
  const { proc, acp } = start('ready');
  try {
    const r = await acp.initialize();
    assert.equal(r.protocolVersion, 1);
    assert.deepEqual(r.agentInfo, { name: 'fake-agy', version: '1.3.0' });
    assert.deepEqual(r.authMethods, [{ id: 'google', name: 'Sign in with Google' }]);
    assert.equal(r.authenticated, true);
    const echoed = await proc.request<any>('test/echo', {});
    assert.equal(echoed.jsonrpc, '2.0');
  } finally { await proc.close(); }
});

test('sign-in: the auth line fires onAuthUrl and framing keeps working', async () => {
  const { proc, acp } = start('signin');
  const urls: string[] = [];
  const texts: string[] = [];
  acp.onAuthUrl((u) => urls.push(u));
  proc.onTextLine((l) => texts.push(l));
  try {
    const before = await acp.initialize();
    assert.equal(before.authenticated, false);
    await assert.rejects(acp.newSession(process.cwd()), (e: any) => e.code === -32000 && /Authentication required/.test(e.message));
    await acp.authenticate('google');
    assert.equal(urls.length, 1);
    assert.match(urls[0], /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
    assert.ok(texts.includes('Starting sign-in...'), 'other text lines reach onTextLine');
    const after = await acp.initialize();
    assert.equal(after.authenticated, true);
    assert.equal(await acp.newSession(process.cwd()), 'sess_1');
  } finally { await proc.close(); }
});

test('sign-in: an auth line on stderr fires onAuthUrl too (the real agy_acp_server prints it there)', async () => {
  const { proc, acp } = start('signin', { FAKE_AUTH_STREAM: 'stderr' });
  const urls: string[] = [];
  acp.onAuthUrl((u) => urls.push(u));
  try {
    await acp.initialize();
    await acp.authenticate('google');
    // stderr is read separately from stdout: give its last line a moment
    for (let i = 0; i < 100 && urls.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(urls.length, 1);
    assert.match(urls[0], /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
  } finally { await proc.close(); }
});

test('initialize without an authenticated flag but with auth methods reports null (unknown)', async () => {
  const { proc, acp } = start('ready', { FAKE_NO_AUTH_FLAG: '1' });
  try {
    const r = await acp.initialize();
    assert.equal(r.authenticated, null);
    assert.equal(r.authMethods.length, 1);
  } finally { await proc.close(); }
});

for (const [name, url] of [
  ['non-Google origin', 'https://accounts.google.com.evil.example/o/oauth2/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A51234%2F'],
  ['extra redirect_uri', `${GOOD}&redirect_uri=https%3A%2F%2Fevil.example%2F`],
  ['non-loopback redirect', 'https://accounts.google.com/o/oauth2/auth?redirect_uri=http%3A%2F%2Fevil.example%3A51234%2F'],
] as const) {
  test(`a malicious auth line is ignored (${name})`, async () => {
    const { proc, acp } = start('signin', { FAKE_AUTH_URL: url });
    const urls: string[] = [];
    acp.onAuthUrl((u) => urls.push(u));
    try {
      await acp.initialize();
      await acp.authenticate('google');
      assert.deepEqual(urls, []);
      assert.equal(await acp.newSession(process.cwd()), 'sess_1', 'framing still works');
    } finally { await proc.close(); }
  });
}

test('parseAuthUrl is strict', () => {
  assert.equal(parseAuthUrl(GOOD), GOOD);
  assert.equal(parseAuthUrl(`  ${GOOD}  `), GOOD);
  const v1 = 'https://accounts.google.com/o/oauth2/auth?client_id=x&scope=openid+email&redirect_uri=http%3A%2F%2F127.0.0.1%3A8080%2F&state=abc%3D';
  assert.equal(parseAuthUrl(v1), new URL(v1).href);
  // the normalised href is returned, not the raw text
  assert.equal(parseAuthUrl('HTTPS://accounts.google.com/o/oauth2/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A1%2F'), null, 'raw must start with the exact origin');
  assert.equal(parseAuthUrl('https://accounts.google.com/o/oauth2/./auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A1%2F'), 'https://accounts.google.com/o/oauth2/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A1%2F');
  const bad = [
    'http://accounts.google.com/o/oauth2/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A1%2F',
    'https://evil.example/o/oauth2/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A1%2F',
    'https://user@accounts.google.com/o/oauth2/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A1%2F',
    'https://accounts.google.com:444/o/oauth2/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A1%2F',
    'https://accounts.google.com/o/oauth2/auth',
    'https://accounts.google.com/o/oauth2/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A1%2F&redirect_uri=http%3A%2F%2F127.0.0.1%3A1%2F',
    'https://accounts.google.com/o/oauth2/auth?redirect_uri=http%3A%2F%2F127.0.0.1%2F',
    'https://accounts.google.com/o/oauth2/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A1%2Fcb',
    'https://accounts.google.com/o/oauth2/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3Aabc%2F',
    'https://accounts.google.com/o/oauth2/auth?redirect_uri=https%3A%2F%2F127.0.0.1%3A1%2F',
    'https://accounts.google.com/o/oauth2/auth?redirect_uri=http%3A%2F%2Flocalhost%3A1%2F',
    'https://accounts.google.com/o/oauth2/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A99999%2F',
    `${GOOD} trailing`,
    'not a url',
    // outside the allowed path list
    'https://accounts.google.com/signin?redirect_uri=http%3A%2F%2F127.0.0.1%3A1%2F',
    'https://accounts.google.com/o/oauth2/v2/auth/extra?redirect_uri=http%3A%2F%2F127.0.0.1%3A1%2F',
    // shell metacharacters and non-printable / non-ASCII characters
    `${GOOD}&state="x"`,
    `${GOOD}&state=a^b`,
    `${GOOD}&calc`,
    `${GOOD}&state=%calc%`,
    `${GOOD}&state=a|b`,
    `${GOOD}&state=a<b`,
    `${GOOD}&state=a\\b`,
    `${GOOD}&state=a\u0000b`,
    `${GOOD}&state=a\u001bb`,
    `${GOOD}&state=a‮b`,
    `https://accounts.google.com/o/oauth2/auth‮?redirect_uri=http%3A%2F%2F127.0.0.1%3A1%2F`,
  ];
  for (const u of bad) assert.equal(parseAuthUrl(u), null, u);
});

test('a turn streams updates and returns the stop reason', async () => {
  const { proc, acp } = start('turn');
  const updates: Array<[string, any]> = [];
  acp.onUpdate((sid, u) => updates.push([sid, u]));
  try {
    await acp.initialize();
    const sid = await acp.newSession(process.cwd());
    const r = await acp.prompt(sid, 'hi');
    assert.deepEqual(r, { stopReason: 'end_turn' });
    assert.deepEqual(updates.map(([s, u]) => [s, u.sessionUpdate]), [
      [sid, 'agent_message_chunk'], [sid, 'agent_message_chunk'], [sid, 'tool_call'], [sid, 'tool_call_update'],
    ]);
    assert.equal(updates.map(([, u]) => u.content?.text ?? '').join(''), 'Hello world');
    assert.equal(updates[3][1].status, 'completed');
  } finally { await proc.close(); }
});

test('loadSession sends session/load', async () => {
  const { proc, acp } = start('ready');
  const updates: string[] = [];
  acp.onUpdate((sid) => updates.push(sid));
  try {
    await acp.loadSession('sess_old', process.cwd());
    assert.deepEqual(updates, ['sess_old']);
    await assert.rejects(acp.loadSession('nope', process.cwd()), /not found/);
  } finally { await proc.close(); }
});

for (const [decision, expected] of [
  [{ optionId: 'allow_once' }, 'permission: allow_once'],
  [{ optionId: 'reject_once' }, 'permission: reject_once'],
  ['cancelled', 'permission: cancelled'],
  [{ optionId: 'not_offered' }, 'permission: cancelled'],
] as const) {
  test(`permission round-trip (${typeof decision === 'string' ? decision : decision.optionId})`, async () => {
    const { proc, acp } = start('permission');
    const texts: string[] = [];
    let seen: any;
    acp.onUpdate((_s, u) => { if (u.sessionUpdate === 'agent_message_chunk') texts.push(u.content.text); });
    acp.onPermission(async (sid, req) => { seen = { sid, req }; return decision; });
    try {
      await acp.initialize();
      const sid = await acp.newSession(process.cwd());
      const r = await acp.prompt(sid, 'run tests');
      assert.equal(r.stopReason, 'end_turn');
      assert.equal(seen.sid, sid);
      assert.deepEqual(seen.req.options.map((o: any) => o.optionId), ['allow_once', 'reject_once']);
      assert.equal(seen.req.toolCall.toolCallId, 'call_1');
      assert.deepEqual(texts, [expected]);
    } finally { await proc.close(); }
  });
}

test('cancel sends session/cancel and the turn ends cancelled', async () => {
  const { proc, acp } = start('cancel');
  try {
    await acp.initialize();
    const sid = await acp.newSession(process.cwd());
    acp.onUpdate((s, u) => { if (u.sessionUpdate === 'agent_message_chunk') acp.cancel(s); });
    const r = await acp.prompt(sid, 'long job');
    assert.deepEqual(r, { stopReason: 'cancelled' });
  } finally { await proc.close(); }
});

test('a crash mid-turn rejects the prompt', async () => {
  const { proc, acp } = start('crash');
  let exitCode: number | null | undefined;
  proc.onExit((c) => { exitCode = c; });
  try {
    await acp.initialize();
    const sid = await acp.newSession(process.cwd());
    await assert.rejects(acp.prompt(sid, 'hi'), /exited/);
    assert.equal(exitCode, 1);
  } finally { await proc.close(); }
});

test('cancel answers an unanswered permission request with cancelled and the turn ends cancelled', async () => {
  const { proc, acp } = start('permcancel');
  const texts: string[] = [];
  let calls = 0;
  let asked!: () => void;
  const heard = new Promise<void>((r) => { asked = r; });
  acp.onUpdate((_s, u) => { if (u.sessionUpdate === 'agent_message_chunk') texts.push(u.content.text); });
  acp.onPermission(() => { calls++; asked(); return new Promise(() => {}); }); // the user never answers
  try {
    await acp.initialize();
    const sid = await acp.newSession(process.cwd());
    const turn = acp.prompt(sid, 'run tests');
    await heard;
    acp.cancel(sid);
    acp.cancel(sid); // a second cancel must not answer twice
    assert.deepEqual(await turn, { stopReason: 'cancelled' });
    assert.deepEqual(texts, ['permission: cancelled']);
    assert.equal(calls, 1);
  } finally { await proc.close(); }
});

for (const [name, handler] of [
  ['throws', async () => { throw new Error('boom'); }],
  ['returns undefined', async () => undefined],
] as const) {
  test(`a permission handler that ${name} is answered cancelled`, async () => {
    const { proc, acp } = start('permission');
    const texts: string[] = [];
    acp.onUpdate((_s, u) => { if (u.sessionUpdate === 'agent_message_chunk') texts.push(u.content.text); });
    acp.onPermission(handler as any);
    try {
      await acp.initialize();
      const sid = await acp.newSession(process.cwd());
      assert.equal((await acp.prompt(sid, 'x')).stopReason, 'end_turn');
      assert.deepEqual(texts, ['permission: cancelled']);
    } finally { await proc.close(); }
  });
}

test('an unknown request from the agent gets -32601', async () => {
  const { proc, acp } = start('unknownreq');
  const texts: string[] = [];
  acp.onUpdate((_s, u) => { if (u.sessionUpdate === 'agent_message_chunk') texts.push(u.content.text); });
  try {
    await acp.initialize();
    const sid = await acp.newSession(process.cwd());
    await acp.prompt(sid, 'x');
    assert.deepEqual(texts, ['error: -32601']);
  } finally { await proc.close(); }
});

test('a missing stopReason is reported as unknown', async () => {
  const { proc, acp } = start('badstop');
  try {
    await acp.initialize();
    const sid = await acp.newSession(process.cwd());
    assert.deepEqual(await acp.prompt(sid, 'x'), { stopReason: 'unknown' });
  } finally { await proc.close(); }
});
