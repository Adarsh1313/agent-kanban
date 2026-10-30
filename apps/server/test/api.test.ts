import { PickerBusyError } from '../src/folder-picker.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Chat, HistoryChat, UsageReading, ServerEvent } from '@agent-kanban/shared';
import { createApi } from '../src/api.ts';
import { ActiveElsewhereError, CantContinueError } from '../src/chats.ts';
import { suggest } from '@agent-kanban/shared';

const chat = (id = 'c1'): Chat => ({
  id, provider: 'codex', cwd: '/x', title: 't', model: null, sessionRef: null, column: 'in_progress',
  reason: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', doneAt: null,
} as unknown as Chat);
const reading = (provider: 'claude' | 'codex', left: number): UsageReading => ({
  provider, status: 'ok', readAt: '2026-01-01T00:00:00Z',
  windows: [{ kind: 'five_hour', label: '5-hour', leftPct: left, resetsAt: null }],
});
const hist: HistoryChat[] = [
  { provider: 'claude', sessionRef: 's1', title: 'h' } as unknown as HistoryChat,
  { provider: 'antigravity', sessionRef: 'ag1', title: 'g' } as unknown as HistoryChat,
];
const dir = mkdtempSync(join(tmpdir(), 'ak-api-'));

async function setup(overrides: Record<string, unknown> = {}, pingMs?: number, extra: Record<string, unknown> = {}) {
  let emit: (e: ServerEvent) => void = () => {};
  const readings = [reading('claude', 40), reading('codex', 70)];
  const chats: any = {
    listChats: () => [chat()],
    getChat: (id: string) => { if (id !== 'c1') throw new Error('Chat not found.'); return chat(id); },
    listMessages: (id: string) => { if (id !== 'c1') throw new Error('Chat not found.'); return []; },
    start: async () => { const c = chat(); emit({ type: 'chat.updated', chat: c }); return c; },
    send: async () => {}, answer: async () => { throw new Error('That request is no longer open.'); },
    stop: async () => {}, markDone: () => chat(), dragOutOfDone: () => chat(), archive: () => chat(),
    continueHistory: async () => { throw new ActiveElsewhereError(); },
    ...overrides,
  };
  const usage: any = { latest: () => readings, refresh: async () => readings };
  const api = createApi({ chats, usage, history: async () => hist, token: 'tok', ...(pingMs ? { pingMs } : {}), ...extra });
  emit = api.broadcast;
  await new Promise<void>((r) => api.server.listen(0, '127.0.0.1', r));
  const addr = api.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${addr.port}`;
  const f = (path: string, init: RequestInit = {}, token: string | null = 'tok') =>
    fetch(base + path, { ...init, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers as object) } });
  return { api, addr, base, f, readings, close: () => { api.close(); api.server.closeAllConnections(); api.server.close(); } };
}

test('401 without token on HTTP and WebSocket', async () => {
  const s = await setup();
  try {
    assert.equal((await s.f('/api/chats', {}, null)).status, 401);
    assert.equal((await s.f('/api/chats', {}, 'wrong')).status, 401);
    const ws = new WebSocket(`ws://127.0.0.1:${s.addr.port}/ws`);
    const code = await new Promise((res) => { ws.on('unexpected-response', (_q, r) => res(r.statusCode)); ws.on('error', () => {}); });
    assert.equal(code, 401);
    ws.terminate();
    const bad = new WebSocket(`ws://127.0.0.1:${s.addr.port}/ws?token=wrong`);
    const code2 = await new Promise((res) => { bad.on('unexpected-response', (_q, r) => res(r.statusCode)); bad.on('error', () => {}); });
    assert.equal(code2, 401);
    bad.terminate();
  } finally { s.close(); }
});

test('POST /api/chats returns 201 and chat.updated arrives on the socket', async () => {
  const s = await setup();
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${s.addr.port}/ws?token=tok`);
    await new Promise((r) => ws.on('open', r));
    const got = new Promise<ServerEvent>((r) => ws.on('message', (d) => r(JSON.parse(String(d)))));
    const res = await s.f('/api/chats', { method: 'POST', body: JSON.stringify({ provider: 'codex', cwd: dir, prompt: 'hi' }) });
    assert.equal(res.status, 201);
    assert.equal((await res.json() as Chat).id, 'c1');
    assert.equal((await got).type, 'chat.updated');
    ws.close();
  } finally { s.close(); }
});

test('bad bodies give 400 with an error', async () => {
  const s = await setup();
  try {
    for (const body of [{ provider: 'nope' }, { provider: 'codex', cwd: '', prompt: 'x' }, { provider: 'codex', cwd: '/x' }]) {
      const res = await s.f('/api/chats', { method: 'POST', body: JSON.stringify(body) });
      assert.equal(res.status, 400);
      assert.equal(typeof ((await res.json()) as { error: string }).error, 'string');
    }
    assert.equal((await s.f('/api/chats', { method: 'POST', body: 'not json' })).status, 400);
  } finally { s.close(); }
});

test('active-elsewhere refusal is 409 with its message', async () => {
  const s = await setup();
  try {
    const res = await s.f('/api/history/continue', { method: 'POST', body: JSON.stringify({ provider: 'claude', sessionRef: 's1', text: 'go' }) });
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as { error: string }).error, /active in Claude Code/);
    const missing = await s.f('/api/history/continue', { method: 'POST', body: JSON.stringify({ provider: 'claude', sessionRef: 'zz', text: 'go' }) });
    assert.equal(missing.status, 404);
  } finally { s.close(); }
});

test('GET /api/usage returns readings and suggested', async () => {
  const s = await setup();
  try {
    const body = await (await s.f('/api/usage')).json() as { readings: UsageReading[]; suggested: string | null };
    assert.deepEqual(body.readings, s.readings);
    assert.equal(body.suggested, suggest(s.readings, ['claude', 'codex', 'antigravity']));
    assert.equal(body.suggested, 'codex');
    const r = await (await s.f('/api/usage/refresh', { method: 'POST' })).json() as { suggested: string };
    assert.equal(r.suggested, 'codex');
  } finally { s.close(); }
});

test('server address is 127.0.0.1', async () => {
  const s = await setup();
  try { assert.equal(s.addr.address, '127.0.0.1'); } finally { s.close(); }
});

test('errors map: unknown chat 404, closed request 409, unknown route 404, other 500', async () => {
  const s = await setup({ markDone: () => { throw new Error('boom'); } });
  const orig = console.error; console.error = () => {};
  try {
    assert.equal((await s.f('/api/chats/zz/messages')).status, 404);
    assert.equal((await s.f('/api/chats/c1/requests/r', { method: 'POST', body: JSON.stringify({ decision: 'allow' }) })).status, 409);
    assert.equal((await s.f('/api/nope')).status, 404);
    const r = await s.f('/api/chats/c1/done', { method: 'POST' });
    assert.equal(r.status, 500);
    assert.deepEqual(await r.json(), { error: 'Something went wrong.' });
  } finally { console.error = orig; s.close(); }
});

test('CORS only for localhost origins; preflight needs no token', async () => {
  const s = await setup();
  try {
    const ok = await fetch(s.base + '/api/chats', { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173' } });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    const bad = await fetch(s.base + '/api/chats', { method: 'OPTIONS', headers: { Origin: 'http://evil.com' } });
    assert.equal(bad.headers.get('access-control-allow-origin'), null);
    const get = await s.f('/api/chats', { headers: { Origin: 'http://127.0.0.1:5173' } });
    assert.equal(get.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5173');
  } finally { s.close(); }
});

test('oversized body is 413', async () => {
  const s = await setup();
  try {
    const res = await s.f('/api/chats', { method: 'POST', body: 'x'.repeat(1_100_000) });
    assert.equal(res.status, 413);
  } finally { s.close(); }
});

test('upgrade on a non-/ws path is refused even with the token', async () => {
  const s = await setup();
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${s.addr.port}/other?token=tok`);
    const code = await new Promise((res) => { ws.on('unexpected-response', (_q, r) => res(r.statusCode)); ws.on('error', () => {}); });
    assert.equal(code, 404);
    ws.terminate();
  } finally { s.close(); }
});

test('a client that never answers pings is terminated', async () => {
  const s = await setup({}, 40);
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${s.addr.port}/ws?token=tok`, { autoPong: false });
    await new Promise((r) => ws.on('open', r));
    await new Promise<void>((r) => ws.on('close', () => r()));
  } finally { s.close(); }
});

test('GET / with a valid ?token= returns 200; other paths reject ?token=', async () => {
  const s = await setup();
  try {
    assert.equal((await s.f('/?token=tok', {}, null)).status, 200);
    assert.equal((await s.f('/?token=bad', {}, null)).status, 401);
    assert.equal((await s.f('/api/chats?token=tok', {}, null)).status, 401);
  } finally { s.close(); }
});

test('bad percent-escape is 404; non-string model is 400', async () => {
  const s = await setup();
  try {
    assert.equal((await s.f('/api/chats/%E0%A4%A/messages')).status, 404);
    const r = await s.f('/api/chats', { method: 'POST', body: JSON.stringify({ provider: 'codex', cwd: '/x', prompt: 'p', model: 5 }) });
    assert.equal(r.status, 400);
  } finally { s.close(); }
});

test('a malformed upgrade target does not crash the server', async () => {
  const s = await setup();
  try {
    const { connect } = await import('node:net');
    const raw = connect(s.addr.port, '127.0.0.1');
    await new Promise((r) => raw.on('connect', r));
    raw.write('GET // HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
    await new Promise((r) => { raw.on('close', r); raw.on('error', r); raw.resume(); });
    assert.equal((await s.f('/api/chats')).status, 200);
  } finally { s.close(); }
});

test('GET /api/connections lists health; POST /api/connections/check runs a check (optionally for one provider)', async () => {
  const health = (provider: 'claude' | 'codex') => ({
    provider, installed: true, path: 'p', version: '1.0.0', latestVersion: '1.0.0', updateAvailable: false,
    signedIn: true, processOk: true, status: 'connected', message: null, checkedAt: '2026-01-01T00:00:00Z',
  });
  const calls: Array<string | undefined> = [];
  const connections = {
    latest: () => [health('claude'), health('codex')],
    check: async (p?: string) => { calls.push(p); return p ? [health(p as 'codex')] : [health('claude'), health('codex')]; },
  };
  const s = await setup({}, undefined, { connections });
  try {
    const got = await s.f('/api/connections');
    assert.equal(got.status, 200);
    assert.deepEqual((await got.json() as any[]).map((h) => h.provider), ['claude', 'codex']);
    assert.equal((await s.f('/api/connections', {}, null)).status, 401);
    const all = await s.f('/api/connections/check', { method: 'POST' });
    assert.equal(all.status, 200);
    assert.equal((await all.json() as any[]).length, 2);
    const one = await s.f('/api/connections/check', { method: 'POST', body: JSON.stringify({ provider: 'codex' }) });
    assert.deepEqual((await one.json() as any[]).map((h) => h.provider), ['codex']);
    assert.deepEqual(calls, [undefined, 'codex']);
    assert.equal((await s.f('/api/connections/check', { method: 'POST', body: JSON.stringify({ provider: 'nope' }) })).status, 400);
  } finally { s.close(); }
});

test('GET /api/connections is an empty list when no monitor is wired', async () => {
  const s = await setup();
  try {
    assert.deepEqual(await (await s.f('/api/connections')).json(), []);
  } finally { s.close(); }
});

test('POST /api/chats with a folder that does not exist, or a file, is 400', async () => {
  let started = 0;
  const s = await setup({ start: async () => { started++; return chat(); } });
  try {
    const file = join(dir, 'a-file.txt');
    writeFileSync(file, 'x');
    for (const cwd of [join(dir, 'missing'), file]) {
      const r = await s.f('/api/chats', { method: 'POST', body: JSON.stringify({ provider: 'codex', cwd, prompt: 'hi' }) });
      assert.equal(r.status, 400);
      assert.deepEqual(await r.json(), { error: "That folder doesn't exist." });
    }
    assert.equal(started, 0);
  } finally { s.close(); }
});

test('Antigravity chats start, and a history continue Antigravity refuses answers 409', async () => {
  let started: any = null;
  const s = await setup({
    start: async (input: any) => { started = input; return chat(); },
    continueHistory: async () => { throw new CantContinueError("This Antigravity chat can't be continued here yet. Start a new chat in the same folder."); },
  });
  try {
    const a = await s.f('/api/chats', { method: 'POST', body: JSON.stringify({ provider: 'antigravity', cwd: dir, prompt: 'hi' }) });
    assert.equal(a.status, 201);
    assert.equal(started.provider, 'antigravity');
    const b = await s.f('/api/history/continue', { method: 'POST', body: JSON.stringify({ provider: 'antigravity', sessionRef: 'ag1', text: 'go' }) });
    assert.equal(b.status, 409);
    assert.deepEqual(await b.json(), { error: "This Antigravity chat can't be continued here yet. Start a new chat in the same folder." });
  } finally { s.close(); }
});

test('GET /api/chats/:id/requests and /tool-calls read back open requests and tool calls', async () => {
  const open = [{ requestId: 'r1', kind: 'permission', summary: 'npm test', createdAt: '2026-01-01T00:00:00Z' }];
  const tools = [{ id: 't1', chatId: 'c1', name: 'Bash', summary: 'Running ls', status: 'done', createdAt: '2026-01-01T00:00:00Z' }];
  const nf = () => { throw new Error('Chat not found.'); };
  const s = await setup({
    listOpenRequests: (id: string) => (id === 'c1' ? open : nf()),
    listToolCalls: (id: string) => (id === 'c1' ? tools : nf()),
  });
  try {
    assert.deepEqual(await (await s.f('/api/chats/c1/requests')).json(), open);
    assert.deepEqual(await (await s.f('/api/chats/c1/tool-calls')).json(), tools);
    assert.equal((await s.f('/api/chats/zz/requests')).status, 404);
    assert.equal((await s.f('/api/chats/zz/tool-calls')).status, 404);
  } finally { s.close(); }
});

test('PATCH /api/chats/:id round-trips pin, title and snooze, and broadcasts', async () => {
  const stored: any = chat();
  const events: ServerEvent[] = [];
  const s = await setup({
    patch: (id: string, p: object) => {
      if (id !== 'c1') throw new Error('Chat not found.');
      Object.assign(stored, p);
      events.push({ type: 'chat.updated', chat: { ...stored } });
      return { ...stored };
    },
  });
  const patch = (body: unknown, id = 'c1') => s.f(`/api/chats/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
  try {
    let r = await patch({ pinned: true });
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as Chat).pinned, true);
    r = await patch({ title: '  New name  ', snoozedUntil: '2026-02-01T00:00:00Z' });
    const c = (await r.json()) as Chat;
    assert.equal(c.title, 'New name');
    assert.equal(c.snoozedUntil, '2026-02-01T00:00:00.000Z');
    assert.equal(((await (await patch({ snoozedUntil: null })).json()) as Chat).snoozedUntil, null);
    assert.equal(events.length, 3);
    assert.equal((await patch({ title: 'x' }, 'nope')).status, 404);
  } finally { s.close(); }
});

test('PATCH /api/chats/:id rejects bad bodies with 400', async () => {
  const s = await setup({ patch: () => { throw new Error('should not be called'); } });
  const patch = (body: unknown) => s.f('/api/chats/c1', { method: 'PATCH', body: JSON.stringify(body) });
  try {
    for (const b of [{ title: '   ' }, { title: 5 }, { title: 'x'.repeat(201) }, { pinned: 'yes' }, { snoozedUntil: 5 }, { snoozedUntil: 'tomorrow' }, { column: 'done' }, { title: 'ok', cwd: '/' }]) {
      const r = await patch(b);
      assert.equal(r.status, 400, JSON.stringify(b));
      assert.match(((await r.json()) as { error: string }).error, /\w/);
    }
    assert.equal((await s.f('/api/chats/c1', { method: 'PATCH', body: JSON.stringify({ pinned: true }) }, null)).status, 401);
  } finally { s.close(); }
});

test('GET /api/models lists each provider, empty for a missing adapter or a failure', async () => {
  const adapters = {
    get: (id: string) => id === 'claude' ? { listModels: async () => [{ id: 'default', label: 'Default', isDefault: true }] }
      : id === 'codex' ? { listModels: async () => { throw new Error('boom'); } } : undefined,
  };
  const s = await setup({}, undefined, { adapters });
  try {
    const r = await s.f('/api/models');
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { claude: [{ id: 'default', label: 'Default', isDefault: true }], codex: [], antigravity: [] });
  } finally { s.close(); }
});

test('GET /api/models caches a provider list that came back non-empty; an empty one is asked again', async () => {
  let claudeCalls = 0;
  let codexCalls = 0;
  const adapters = {
    get: (id: string) => id === 'claude' ? { listModels: async () => { claudeCalls++; return [{ id: 'default', label: 'Default', isDefault: true }]; } }
      : id === 'codex' ? { listModels: async () => { codexCalls++; return []; } } : undefined,
  };
  const s = await setup({}, undefined, { adapters });
  try {
    await (await s.f('/api/models')).json();
    const second = await (await s.f('/api/models')).json() as Record<string, unknown[]>;
    assert.equal(second.claude!.length, 1);
    assert.equal(claudeCalls, 1, 'served from the cache');
    assert.equal(codexCalls, 2, 'an empty list is not cached');
  } finally { s.close(); }
});

test('PATCH /api/chats/:id trims the title before checking it, normalises snoozedUntil, and says why a bad snooze fails', async () => {
  let got: any = null;
  const s = await setup({ patch: (_id: string, p: object) => { got = p; return chat(); } });
  const patch = (body: unknown) => s.f('/api/chats/c1', { method: 'PATCH', body: JSON.stringify(body) });
  try {
    assert.equal((await patch({ title: `   ${'x'.repeat(200)}   ` })).status, 200);
    assert.equal(got.title, 'x'.repeat(200));
    assert.equal((await patch({ snoozedUntil: '2026-02-01T05:30:00+05:30' })).status, 200);
    assert.equal(got.snoozedUntil, '2026-02-01T00:00:00.000Z');
    const bad = await patch({ snoozedUntil: 'tomorrow' });
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as { error: string }).error, 'Snooze time must be a date.');
  } finally { s.close(); }
});

test('POST /api/folders/pick returns the chosen folder (null when cancelled); a second picker is 409; none wired is 404 (#24)', async () => {
  const answers: (string | null)[] = ['C:\Work\my-app', null];
  const s = await setup({}, undefined, { folderPicker: { pick: async () => answers.shift() ?? null } });
  try {
    assert.deepEqual(await (await s.f('/api/folders/pick', { method: 'POST' })).json(), { path: 'C:\Work\my-app' });
    assert.deepEqual(await (await s.f('/api/folders/pick', { method: 'POST' })).json(), { path: null });
    assert.equal((await s.f('/api/folders/pick', { method: 'POST' }, null)).status, 401);
  } finally { s.close(); }
  const busy = await setup({}, undefined, { folderPicker: { pick: async () => { throw new PickerBusyError(); } } });
  try {
    const r = await busy.f('/api/folders/pick', { method: 'POST' });
    assert.equal(r.status, 409);
    assert.match((await r.json()).error, /already open/);
  } finally { busy.close(); }
  const none = await setup();
  try { assert.equal((await none.f('/api/folders/pick', { method: 'POST' })).status, 404); } finally { none.close(); }
});

test('GET /api/history/:provider/:ref/messages returns the transcript; unknown provider 400; none wired 404 (#16)', async () => {
  const asked: string[] = [];
  const s = await setup({}, undefined, { transcript: async (p: string, ref: string) => { asked.push(`${p}:${ref}`); return { messages: [{ role: 'user', text: 'hi', at: null }], truncated: false, unavailable: false }; } });
  try {
    const r = await s.f('/api/history/claude/abc-123/messages');
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).messages, [{ role: 'user', text: 'hi', at: null }]);
    assert.equal((await s.f('/api/history/gemini/abc/messages')).status, 400);
    assert.equal((await s.f('/api/history/claude/abc/messages', {}, null)).status, 401);
    await s.f('/api/history/codex/..%2F..%2Fx/messages');
    assert.deepEqual(asked, ['claude:abc-123', 'codex:../../x']); // the reader refuses path-like refs (transcript.test.ts)
  } finally { s.close(); }
  const none = await setup();
  try { assert.equal((await none.f('/api/history/claude/abc/messages')).status, 404); } finally { none.close(); }
});
