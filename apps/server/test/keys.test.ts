// Your own API keys (#43) over the HTTP API, with a fake key store standing in for the desktop app's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { ApiKey, Chat, KeyRequest, ServerEvent } from '@agent-kanban/shared';
import { createApi } from '../src/api.ts';
import { KeyService, desktopVault, type KeyVault } from '../src/keys.ts';

export const SECRET = 'sk-ant-api03-do-not-leak-this-value-9z9z';

/** An in-memory key store: what the desktop app's KeyFile answers, without the encryption. */
export class FakeVault implements KeyVault {
  keys: (ApiKey & { value: string })[] = [];
  requests: KeyRequest['op'][] = [];
  failWith: Error | null = null;
  private n = 0;
  async request(r: KeyRequest): Promise<unknown> {
    this.requests.push(r.op);
    if (this.failWith) throw this.failWith;
    const meta = ({ value: _v, ...k }: ApiKey & { value: string }): ApiKey => k;
    switch (r.op) {
      case 'list': return this.keys.map(meta);
      case 'add': {
        const k = { id: `k${++this.n}`, provider: r.provider, name: r.name, last4: r.key.slice(-4), capUsd: null, spentUsd: 0, month: '2026-11', value: r.key };
        this.keys.push(k);
        return meta(k);
      }
      case 'update': {
        const k = this.keys.find((x) => x.id === r.id);
        if (!k) return null;
        Object.assign(k, r.patch);
        return meta(k);
      }
      case 'remove': {
        const before = this.keys.length;
        this.keys = this.keys.filter((x) => x.id !== r.id);
        return this.keys.length < before;
      }
      case 'reveal': return this.keys.find((x) => x.id === r.id)?.value ?? null;
    }
  }
}

async function setup(withKeys = true, now = () => new Date(2026, 10, 5)) {
  const vault = new FakeVault();
  const events: ServerEvent[] = [];
  const keys = withKeys ? new KeyService({ vault, broadcast: (e) => events.push(e), now }) : undefined;
  const chats: any = { listChats: () => [] as Chat[] };
  const api = createApi({ chats, usage: { latest: () => [] } as any, history: async () => [], token: 'tok', ...(keys ? { keys } : {}) });
  await new Promise<void>((r) => api.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  const f = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json', ...(init.headers as object) } });
  const post = (path: string, body: unknown, method = 'POST') => f(path, { method, body: JSON.stringify(body) });
  return { vault, events, keys, f, post, close: () => { api.close(); api.server.closeAllConnections(); api.server.close(); } };
}

/** Captures everything written to the console while `fn` runs. */
async function consoleDuring(fn: () => Promise<void>): Promise<string> {
  const out: string[] = [];
  const names = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const saved = names.map((n) => console[n]);
  for (const n of names) console[n] = (...args: unknown[]) => { out.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  try { await fn(); } finally { names.forEach((n, i) => { console[n] = saved[i]!; }); }
  return out.join('\n');
}

test('POST /api/keys returns metadata with last 4, never the key; GET never contains it', async () => {
  const s = await setup();
  try {
    const r = await s.post('/api/keys', { provider: 'claude', name: ' Personal ', key: SECRET });
    assert.equal(r.status, 201);
    const text = await r.text();
    assert.equal(text.includes(SECRET), false);
    const added = JSON.parse(text) as ApiKey;
    assert.deepEqual({ name: added.name, last4: added.last4, capUsd: added.capUsd, spentUsd: added.spentUsd }, { name: 'Personal', last4: '9z9z', capUsd: null, spentUsd: 0 });
    const list = await (await s.f('/api/keys')).text();
    assert.equal(list.includes(SECRET), false);
    assert.equal((JSON.parse(list) as ApiKey[]).length, 1);
    assert.equal(JSON.stringify(s.events).includes(SECRET), false);
    assert.ok(s.events.some((e) => e.type === 'keys.updated' && e.keys.length === 1));
  } finally { s.close(); }
});

test('rename, set and clear a cap, delete', async () => {
  const s = await setup();
  try {
    const added = await (await s.post('/api/keys', { provider: 'codex', name: 'Work', key: SECRET })).json() as ApiKey;
    const renamed = await (await s.post(`/api/keys/${added.id}`, { name: 'Team', capUsd: 10 }, 'PATCH')).json() as ApiKey;
    assert.deepEqual({ name: renamed.name, capUsd: renamed.capUsd }, { name: 'Team', capUsd: 10 });
    const cleared = await (await s.post(`/api/keys/${added.id}`, { capUsd: null }, 'PATCH')).json() as ApiKey;
    assert.equal(cleared.capUsd, null);
    assert.equal((await s.post(`/api/keys/${added.id}`, { capUsd: -1 }, 'PATCH')).status, 400);
    assert.equal((await s.f(`/api/keys/${added.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await s.f(`/api/keys/${added.id}`, { method: 'DELETE' })).status, 404);
    assert.deepEqual(await (await s.f('/api/keys')).json(), []);
  } finally { s.close(); }
});

test('bad input: unknown provider, no name, no key', async () => {
  const s = await setup();
  try {
    assert.equal((await s.post('/api/keys', { provider: 'antigravity', name: 'A', key: SECRET })).status, 400);
    assert.equal((await s.post('/api/keys', { provider: 'claude', name: '', key: SECRET })).status, 400);
    assert.equal((await s.post('/api/keys', { provider: 'claude', name: 'A', key: '  ' })).status, 400);
    assert.deepEqual(s.vault.keys, []);
  } finally { s.close(); }
});

test('browser mode: every key route answers 404', async () => {
  const s = await setup(false);
  try {
    assert.equal((await s.f('/api/keys')).status, 404);
    assert.equal((await s.post('/api/keys', { provider: 'claude', name: 'A', key: SECRET })).status, 404);
    assert.equal((await s.post('/api/keys/k1', { name: 'B' }, 'PATCH')).status, 404);
    assert.equal((await s.f('/api/keys/k1', { method: 'DELETE' })).status, 404);
  } finally { s.close(); }
});

test('request bodies with a key are never logged, even when the key store fails', async () => {
  const s = await setup();
  try {
    const logged = await consoleDuring(async () => {
      s.vault.failWith = new Error('disk on fire');
      const r = await s.post('/api/keys', { provider: 'claude', name: 'A', key: SECRET });
      assert.equal(r.status, 500);
      assert.equal((await r.text()).includes(SECRET), false);
      s.vault.failWith = null;
      const bad = await s.f('/api/keys', { method: 'POST', body: `{"provider":"claude","key":"${SECRET}"` });
      assert.equal(bad.status, 400);
      assert.equal((await bad.text()).includes(SECRET), false);
    });
    assert.equal(logged.includes(SECRET), false);
  } finally { s.close(); }
});

test('the desktop vault asks over the IPC channel and matches replies by id', async () => {
  let listener: (m: unknown) => void = () => {};
  const sent: unknown[] = [];
  const vault = desktopVault({ send: (m) => { sent.push(m); }, onMessage: (fn) => { listener = fn; } }, 1_000);
  const a = vault.request({ op: 'list' });
  const b = vault.request({ op: 'reveal', id: 'k1' });
  const [ma, mb] = sent as { reqId: number }[];
  listener({ type: 'keys.reply', reqId: mb!.reqId, ok: false, error: 'API key not found.' });
  listener({ type: 'keys.reply', reqId: ma!.reqId, ok: true, result: [] });
  assert.deepEqual(await a, []);
  await assert.rejects(b, /API key not found/);
});
