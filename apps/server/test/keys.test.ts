// Your own API keys (#43) over the HTTP API, with a fake key store standing in for the desktop app's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { ApiKey, Chat, KeyRequest, ServerEvent } from '@agent-kanban/shared';
import { createApi } from '../src/api.ts';
import { KeyService, desktopVault, overCap, type KeyVault } from '../src/keys.ts';
import { priceTokens } from '../src/spend.ts';
import { Store } from '../src/store.ts';
import { ChatService, KEY_FAILED } from '../src/chats.ts';
import { KeyedAdapters } from '../src/adapters/keyed.ts';
import type { ProviderAdapter } from '../src/adapters/adapter.ts';
import type { AdapterEvent, ProviderId } from '@agent-kanban/shared';

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
  const chats: any = { listChats: () => [] as Chat[], forgetKey: () => {} };
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

/* ───────── Slice 2: a chat on a key ───────── */


class Fake implements ProviderAdapter {
  id: ProviderId;
  capabilities = { effort: true };
  calls: string[] = [];
  listeners = new Set<(e: AdapterEvent) => void>();
  constructor(id: ProviderId) { this.id = id; }
  async startChat() { this.calls.push('startChat'); return { sessionRef: 's1' }; }
  async sendMessage(ref: string, text: string) { this.calls.push(`send:${ref}:${text}`); }
  async respondToRequest() {}
  async stop(ref: string) { this.calls.push(`stop:${ref}`); }
  async resume(ref: string) { this.calls.push(`resume:${ref}`); }
  onEvent(l: (e: AdapterEvent) => void) { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
  async readUsage(): Promise<never> { throw new Error('unused'); }
  async listModels() { return []; }
  async ping() { return { ok: true, signedIn: true }; }
  disposed = false;
  async dispose() { this.disposed = true; }
  emit(e: AdapterEvent) { for (const l of this.listeners) l(e); }
}

async function chatSetup(now = () => new Date(2026, 10, 5)) {
  const store = new Store(':memory:');
  const vault = new FakeVault();
  const events: ServerEvent[] = [];
  const broadcast = (e: ServerEvent) => events.push(e);
  const keys = new KeyService({ vault, broadcast, now });
  const shared = new Fake('claude');
  const spawned: { provider: string; env: Record<string, string>; adapter: Fake }[] = [];
  const keyAdapters = new KeyedAdapters({
    reveal: async (id) => ({ provider: (await keys.get(id)).provider, value: await keys.reveal(id) }),
    create: async (provider, env) => { const adapter = new Fake(provider); spawned.push({ provider, env, adapter }); return adapter; },
  });
  // Wired as main.ts wires it: each cost goes on the key; at the cap, the key's chats stop.
  let spent: Promise<unknown> = Promise.resolve();
  const chats: ChatService = new ChatService({
    store, adapters: { claude: shared }, usage: { refresh: async () => [] } as any, broadcast, claudeHome: '/nowhere', keyed: keyAdapters, suggestNextSteps: () => false,
    spend: (keyId, usd, chatId) => { spent = keys.addSpend(keyId, usd).then((k) => { if (k && overCap(k)) return chats.capReached(keyId, chatId); }); },
    capped: async (keyId) => overCap(await keys.get(keyId)),
  });
  const api = createApi({ chats, keys, keyAdapters, usage: { latest: () => [] } as any, history: async () => [], token: 'tok' });
  const real = api.broadcast;
  api.broadcast = (e) => { events.push(e); real(e); };
  await new Promise<void>((r) => api.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  const f = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' } });
  const post = (path: string, body: unknown, method = 'POST') => f(path, { method, body: JSON.stringify(body) });
  const key = await keys.add({ provider: 'claude', name: 'Personal', key: SECRET });
  return { store, vault, events, keys, shared, spawned, chats, keyAdapters, f, post, key, settled: () => spent, close: () => { api.close(); api.server.closeAllConnections(); api.server.close(); } };
}

/** A chat that ran out of usage on the user's plan. */
async function outOfUsage(s: Awaited<ReturnType<typeof chatSetup>>) {
  const chat = await s.chats.start({ provider: 'claude', cwd: '/w', prompt: 'hello' });
  await s.chats.started(chat.id);
  s.shared.emit({ type: 'limit.reached', sessionRef: 's1', resetsAt: '2026-11-06T00:00:00Z' });
  return s.chats.getChat(chat.id);
}

test('use-key resumes on a process spawned with the key in its env, and the key goes nowhere else', async () => {
  const s = await chatSetup();
  try {
    const logged = await consoleDuring(async () => {
      const chat = await outOfUsage(s);
      assert.equal(chat.needsReason, 'limit');
      const r = await s.post(`/api/chats/${chat.id}/use-key`, { keyId: s.key.id });
      assert.equal(r.status, 200);
      const body = await r.text();
      assert.equal((JSON.parse(body) as Chat).keyId, s.key.id);
      assert.equal(body.includes(SECRET), false);
      assert.equal(s.spawned.length, 1);
      assert.deepEqual(s.spawned[0]!.env, { ANTHROPIC_API_KEY: SECRET });
      // The session resumes on the key's own process; the plan's process is left alone.
      assert.deepEqual(s.spawned[0]!.adapter.calls, ['resume:s1', 'send:s1:Continue where you left off.']);
      assert.deepEqual(s.shared.calls, ['startChat']);
      assert.equal(s.chats.getChat(chat.id).column, 'running');
      // Events from the key's process land on the chat.
      s.spawned[0]!.adapter.emit({ type: 'turn.completed', sessionRef: 's1' });
      assert.equal(s.chats.getChat(chat.id).column, 'review');
    });
    assert.equal(logged.includes(SECRET), false);
    assert.equal(JSON.stringify(s.events).includes(SECRET), false);
    assert.equal(JSON.stringify(s.store.listChats(true)).includes(SECRET), false);
  } finally { s.close(); }
});

test('use-key: a key for another provider, a missing key, a running chat', async () => {
  const s = await chatSetup();
  try {
    const codexKey = await s.keys.add({ provider: 'codex', name: 'Work', key: 'sk-proj-xyz' });
    const chat = await outOfUsage(s);
    assert.equal((await s.post(`/api/chats/${chat.id}/use-key`, { keyId: codexKey.id })).status, 409);
    assert.equal((await s.post(`/api/chats/${chat.id}/use-key`, { keyId: 'nope' })).status, 404);
    await s.post(`/api/chats/${chat.id}/use-key`, { keyId: s.key.id });
    assert.equal((await s.f(`/api/chats/${chat.id}/use-key`, { method: 'DELETE' })).status, 409);
  } finally { s.close(); }
});

test('a key the provider turns down fails with a plain message pointing at Connections', async () => {
  const s = await chatSetup();
  try {
    const chat = await outOfUsage(s);
    await s.post(`/api/chats/${chat.id}/use-key`, { keyId: s.key.id });
    s.spawned[0]!.adapter.emit({ type: 'error', sessionRef: 's1', message: 'Invalid API key · Please run /login' });
    assert.equal(s.store.listMessages(chat.id).at(-1)!.text, KEY_FAILED);
    assert.equal(s.chats.getChat(chat.id).needsReason, 'error');
  } finally { s.close(); }
});

test('deleting a key puts its chats back on the sign-in and ends its process', async () => {
  const s = await chatSetup();
  try {
    const chat = await outOfUsage(s);
    await s.post(`/api/chats/${chat.id}/use-key`, { keyId: s.key.id });
    s.spawned[0]!.adapter.emit({ type: 'turn.completed', sessionRef: 's1' });
    assert.equal((await s.f(`/api/keys/${s.key.id}`, { method: 'DELETE' })).status, 204);
    assert.equal(s.chats.getChat(chat.id).keyId, undefined);
    assert.equal(s.spawned[0]!.adapter.disposed, true);
    await s.chats.send(chat.id, 'next');
    assert.deepEqual(s.shared.calls.slice(-2), ['resume:s1', 'send:s1:next']);
  } finally { s.close(); }
});

/* ───────── Slice 3: spend and the cap ───────── */

test("each turn's cost adds up on the key: Claude dollars and Codex tokens", async () => {
  const s = await chatSetup();
  try {
    const chat = await outOfUsage(s);
    await s.post(`/api/chats/${chat.id}/use-key`, { keyId: s.key.id });
    const keyed = s.spawned[0]!.adapter;
    keyed.emit({ type: 'cost', sessionRef: 's1', usd: 0.5 });
    await s.settled();
    keyed.emit({ type: 'cost', sessionRef: 's1', tokens: { input: 1_000_000, cachedInput: 0, output: 100_000 } });
    await s.settled();
    const [k] = await (await s.f('/api/keys')).json() as ApiKey[];
    assert.equal(k!.spentUsd, 0.5 + 1.25 + 1);
    assert.ok(s.events.some((e) => e.type === 'keys.updated' && e.keys[0]!.spentUsd === 2.75));
  } finally { s.close(); }
});

test('cost on the plan (no key) is not counted anywhere', async () => {
  const s = await chatSetup();
  try {
    await s.chats.start({ provider: 'claude', cwd: '/w', prompt: 'hello' });
    s.shared.emit({ type: 'cost', sessionRef: 's1', usd: 3 });
    await s.settled();
    assert.equal(s.vault.keys[0]!.spentUsd, 0);
  } finally { s.close(); }
});

test('at the cap the running chat stops with Spend cap reached, and no new turn starts on the key', async () => {
  const s = await chatSetup();
  try {
    await s.post(`/api/keys/${s.key.id}`, { capUsd: 1 }, 'PATCH');
    const chat = await outOfUsage(s);
    await s.post(`/api/chats/${chat.id}/use-key`, { keyId: s.key.id });
    const keyed = s.spawned[0]!.adapter;
    keyed.emit({ type: 'turn.started', sessionRef: 's1' });
    keyed.emit({ type: 'cost', sessionRef: 's1', usd: 1.2 });
    await s.settled();
    const after = s.chats.getChat(chat.id);
    assert.deepEqual({ column: after.column, needsReason: after.needsReason }, { column: 'needs_you', needsReason: 'spend-cap' });
    assert.ok(keyed.calls.includes('stop:s1'));
    // The stopped turn's last event doesn't reopen the card.
    keyed.emit({ type: 'turn.completed', sessionRef: 's1' });
    assert.equal(s.chats.getChat(chat.id).needsReason, 'spend-cap');
    const send = await s.post(`/api/chats/${chat.id}/messages`, { text: 'more' });
    assert.equal(send.status, 409);
    assert.match(((await send.json()) as { error: string }).error, /spend cap/);
    // Raising the cap lets it continue.
    await s.post(`/api/keys/${s.key.id}`, { capUsd: 5 }, 'PATCH');
    await s.chats.send(chat.id, 'more');
    assert.equal(s.chats.getChat(chat.id).column, 'running');
  } finally { s.close(); }
});

test('a turn that ends exactly at the cap still lands in Needs you with the reason', async () => {
  const s = await chatSetup();
  try {
    await s.post(`/api/keys/${s.key.id}`, { capUsd: 1 }, 'PATCH');
    const chat = await outOfUsage(s);
    await s.post(`/api/chats/${chat.id}/use-key`, { keyId: s.key.id });
    const keyed = s.spawned[0]!.adapter;
    keyed.emit({ type: 'cost', sessionRef: 's1', usd: 1 });
    keyed.emit({ type: 'turn.completed', sessionRef: 's1' });
    await s.settled();
    assert.equal(s.chats.getChat(chat.id).needsReason, 'spend-cap');
    assert.equal((await s.post(`/api/chats/${chat.id}/use-key`, { keyId: s.key.id })).status, 409); // capped
  } finally { s.close(); }
});

test("the month rolls over: last month's spend shows as 0 and this month counts from 0", async () => {
  let now = new Date(2026, 9, 31, 23, 0);
  const s = await chatSetup(() => now);
  try {
    await s.keys.addSpend(s.key.id, 4);
    assert.equal((await s.keys.get(s.key.id)).spentUsd, 4);
    now = new Date(2026, 10, 1, 0, 5);
    const k = await s.keys.get(s.key.id);
    assert.deepEqual({ spentUsd: k.spentUsd, month: k.month }, { spentUsd: 0, month: '2026-11' });
    await s.keys.addSpend(s.key.id, 0.25);
    assert.deepEqual({ spentUsd: s.vault.keys[0]!.spentUsd, month: s.vault.keys[0]!.month }, { spentUsd: 0.25, month: '2026-11' });
  } finally { s.close(); }
});

test('Codex tokens are priced per million, cached input at the cached rate', () => {
  assert.equal(priceTokens({ input: 1_000_000, cachedInput: 0, output: 0 }), 1.25);
  assert.equal(priceTokens({ input: 1_000_000, cachedInput: 1_000_000, output: 0 }), 0.125);
  assert.equal(priceTokens({ input: 0, cachedInput: 0, output: 1_000_000, model: 'gpt-5-mini' }), 2);
});
