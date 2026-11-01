import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { Store } from '../src/store.ts';
import { SettingsStore } from '../src/settings.ts';
import { createApi } from '../src/api.ts';

/** The API over a settings store in `dir` (a fresh folder by default), with helpers to GET and PATCH settings. */
async function serve(dir = mkdtempSync(join(tmpdir(), 'ak-mine-'))) {
  const settings = new SettingsStore(new Store(join(dir, 'ak.db')));
  const usage: any = { latest: () => [], refresh: async () => [] };
  const api = createApi({ chats: { listChats: () => [] } as any, usage, history: async () => [], token: 'tok', settings });
  await new Promise<void>((r) => api.server.listen(0, '127.0.0.1', r));
  const { port } = api.server.address() as AddressInfo;
  const headers = { Authorization: 'Bearer tok' };
  return {
    port, settings,
    get: async () => (await fetch(`http://127.0.0.1:${port}/api/settings`, { headers })).json() as Promise<any>,
    patch: (body: unknown) => fetch(`http://127.0.0.1:${port}/api/settings`, { method: 'PATCH', headers, body: JSON.stringify(body) }),
    close: () => { api.close(); api.server.closeAllConnections(); api.server.close(); },
  };
}

test('My projects is null until the user picks, then a list that survives a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ak-mine-'));
  const a = await serve(dir);
  try {
    assert.equal((await a.get()).myProjects, null);
    assert.equal((await a.patch({ myProjects: ['/work/one', 'C:\\work\\two'] })).status, 200);
    assert.deepEqual((await a.get()).myProjects, ['/work/one', 'C:\\work\\two']);
  } finally { a.close(); }
  const b = await serve(dir);
  try {
    assert.deepEqual((await b.get()).myProjects, ['/work/one', 'C:\\work\\two']);
    assert.equal((await b.patch({ myProjects: [] })).status, 200, 'an empty list is a real choice');
    assert.deepEqual((await b.get()).myProjects, []);
    assert.equal((await b.patch({ myProjects: null })).status, 200, 'null goes back to "never picked"');
    assert.equal((await b.get()).myProjects, null);
  } finally { b.close(); }
});

test('PATCH refuses a myProjects that is not a list of folders or null, and changes nothing', async () => {
  const s = await serve();
  try {
    for (const bad of ['/work/a', [1], [''], {}, true]) assert.equal((await s.patch({ myProjects: bad, onboarded: true })).status, 400);
    const got = await s.get();
    assert.equal(got.myProjects, null);
    assert.equal(got.onboarded, false);
  } finally { s.close(); }
});

test('PATCH myProjects broadcasts settings.updated so other windows follow', async () => {
  const s = await serve();
  const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws?token=tok`);
  try {
    await new Promise((r) => ws.on('open', r));
    const got = new Promise<any>((r) => ws.on('message', (d) => { const e = JSON.parse(String(d)); if (e.type === 'settings.updated') r(e); }));
    await s.patch({ myProjects: ['/work/one'] });
    assert.deepEqual((await got).settings.myProjects, ['/work/one']);
  } finally { ws.close(); s.close(); }
});
