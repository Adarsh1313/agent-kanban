import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import type { Chat, HistoryChat, UsageReading, ServerEvent } from '@agent-kanban/shared';
import { createApi } from '../src/api.ts';
import { ActiveElsewhereError } from '../src/chats.ts';
import { suggest } from '../src/usage/parse.ts';

const chat = (id = 'c1'): Chat => ({
  id, provider: 'codex', cwd: '/x', title: 't', model: null, sessionRef: null, column: 'in_progress',
  reason: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', doneAt: null,
} as unknown as Chat);
const reading = (provider: 'claude' | 'codex', left: number): UsageReading => ({
  provider, status: 'ok', readAt: '2026-01-01T00:00:00Z',
  windows: [{ kind: 'five_hour', label: '5-hour', leftPct: left, resetsAt: null }],
});
const hist: HistoryChat[] = [{ provider: 'claude', sessionRef: 's1', title: 'h' } as unknown as HistoryChat];

async function setup(overrides: Record<string, unknown> = {}, pingMs?: number) {
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
  const api = createApi({ chats, usage, history: async () => hist, token: 'tok', ...(pingMs ? { pingMs } : {}) });
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
    const res = await s.f('/api/chats', { method: 'POST', body: JSON.stringify({ provider: 'codex', cwd: '/x', prompt: 'hi' }) });
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
