import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { AccountProvider, ServerEvent } from '@agent-kanban/shared';
import { Store } from '../src/store.ts';
import { AccountService, AccountStore, DEFAULT_ACCOUNT } from '../src/accounts.ts';
import { createApi } from '../src/api.ts';

function setup(running = false) {
  const dir = mkdtempSync(join(tmpdir(), 'ak-accounts-'));
  const store = new Store(join(dir, 'ak.db'));
  const homes = { claude: join(dir, '.claude'), codex: join(dir, '.codex') };
  const accounts = new AccountStore({ backend: store, root: join(dir, 'accounts'), providerHome: homes });
  const switched: AccountProvider[] = [];
  const events: ServerEvent[] = [];
  const svc = new AccountService({ accounts, runningOn: () => running, switched: (p) => switched.push(p), emit: (e) => events.push(e) });
  return { dir, store, homes, accounts, svc, switched, events };
}

test('starts with only Default, active, using the provider folder', () => {
  const s = setup();
  assert.deepEqual(s.accounts.list('claude'), [{ id: DEFAULT_ACCOUNT, provider: 'claude', name: 'Default', active: true }]);
  assert.deepEqual(s.accounts.env('claude'), {});
  assert.equal(s.accounts.home('codex'), s.homes.codex);
});

test('adding an account makes it active with its own config folder, sharing the chats folder', () => {
  const s = setup();
  mkdirSync(join(s.homes.claude, 'projects', 'site'), { recursive: true });
  writeFileSync(join(s.homes.claude, 'projects', 'site', 'a.jsonl'), '');
  const list = s.svc.add('claude', 'Work');
  const work = list.find((a) => a.name === 'Work')!;
  assert.equal(work.active, true);
  assert.equal(list.find((a) => a.id === DEFAULT_ACCOUNT)!.active, false);
  const dir = s.accounts.env('claude').CLAUDE_CONFIG_DIR!;
  assert.ok(dir.startsWith(join(s.dir, 'accounts', 'claude')));
  assert.ok(existsSync(join(dir, 'projects', 'site', 'a.jsonl')), 'chats folder is linked');
  assert.deepEqual(s.switched, ['claude']);
  assert.equal(s.events.at(-1)?.type, 'accounts.updated');
  // It survives a restart.
  const again = new AccountStore({ backend: new Store(join(s.dir, 'ak.db')), root: join(s.dir, 'accounts'), providerHome: s.homes });
  assert.equal(again.list('claude').find((a) => a.active)!.name, 'Work');
});

test('names are 1 to 40 characters and unique; Default cannot be renamed or removed', () => {
  const s = setup();
  s.svc.add('codex', 'Work');
  assert.throws(() => s.svc.add('codex', ' '), /1 to 40/);
  assert.throws(() => s.svc.add('codex', 'work'), /already has that name/);
  assert.throws(() => s.svc.rename('codex', DEFAULT_ACCOUNT, 'Mine'), /can't be renamed/);
  assert.throws(() => s.svc.remove('codex', DEFAULT_ACCOUNT), /can't be removed/);
});

test('removing the active account falls back to Default and keeps the shared chats', () => {
  const s = setup();
  mkdirSync(join(s.homes.codex, 'sessions'), { recursive: true });
  writeFileSync(join(s.homes.codex, 'sessions', 'r.jsonl'), 'keep');
  const work = s.svc.add('codex', 'Work').find((a) => a.name === 'Work')!;
  const dir = s.accounts.env('codex').CODEX_HOME!;
  s.svc.remove('codex', work.id);
  assert.deepEqual(s.accounts.env('codex'), {});
  assert.equal(s.accounts.list('codex').length, 1);
  assert.ok(existsSync(join(s.homes.codex, 'sessions', 'r.jsonl')), 'the shared chats are never deleted');
  assert.ok(!existsSync(dir));
});

test('Codex cannot switch while one of its chats runs; Claude can', () => {
  const s = setup(true);
  assert.throws(() => s.svc.add('codex', 'Work'), /Codex chat is running/);
  assert.doesNotThrow(() => s.svc.add('claude', 'Work'));
});

test('the API lists, adds, renames, switches and removes accounts', async () => {
  const s = setup();
  const chats: any = { listChats: () => [] };
  const usage: any = { latest: () => [], refresh: async () => [] };
  const api = createApi({ chats, usage, history: async () => [], token: 'tok', accounts: s.svc });
  await new Promise<void>((r) => api.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  const f = (path: string, method = 'GET', body?: unknown) => fetch(base + path, { method, headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  try {
    assert.equal((await (await f('/api/accounts')).json()).claude.length, 1);
    const added = await f('/api/accounts', 'POST', { provider: 'claude', name: 'Work' });
    assert.equal(added.status, 201);
    const work = (await added.json()).find((a: any) => a.name === 'Work');
    assert.equal((await f(`/api/accounts/claude/${work.id}`, 'PATCH', { name: 'Office' })).status, 200);
    const back = await (await f(`/api/accounts/claude/${DEFAULT_ACCOUNT}/activate`, 'POST')).json();
    assert.equal(back.find((a: any) => a.active).id, DEFAULT_ACCOUNT);
    assert.equal((await f(`/api/accounts/claude/${work.id}`, 'DELETE')).status, 200);
    assert.equal((await f('/api/accounts', 'POST', { provider: 'antigravity', name: 'X' })).status, 400);
    assert.equal((await f('/api/accounts', 'POST', { provider: 'claude', name: 'Default' })).status, 400);
  } finally { api.close(); api.server.closeAllConnections(); api.server.close(); }
});
