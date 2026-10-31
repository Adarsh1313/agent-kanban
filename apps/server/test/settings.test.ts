import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { HistoryChat, Project, Settings, UsageReading } from '@agent-kanban/shared';
import { Store } from '../src/store.ts';
import { SettingsStore, SettingsError, defaultSettings } from '../src/settings.ts';
import { createApi } from '../src/api.ts';

const tempStore = () => new Store(join(mkdtempSync(join(tmpdir(), 'ak-settings-')), 'ak.db'));

test('defaults: not onboarded, every provider shown and suggested', () => {
  const s = new SettingsStore(tempStore());
  assert.deepEqual(s.get(), {
    onboarded: false,
    showChats: { claude: true, codex: true, antigravity: true },
    suggest: { claude: true, codex: true, antigravity: true },
    hiddenProjects: [],
    unhiddenProjects: [],
  });
  assert.deepEqual(s.get(), defaultSettings());
});

test('patch round-trips through the store (partial per-provider updates) and survives a reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ak-settings-'));
  const s = new SettingsStore(new Store(join(dir, 'ak.db')));
  s.patch({ onboarded: true });
  s.patch({ suggest: { codex: false } });
  s.patch({ showChats: { antigravity: false } });
  const out = s.patch({ hiddenProjects: ['/work/old'] });
  const want: Settings = {
    onboarded: true,
    showChats: { claude: true, codex: true, antigravity: false },
    suggest: { claude: true, codex: false, antigravity: true },
    hiddenProjects: ['/work/old'],
    unhiddenProjects: [],
  };
  assert.deepEqual(out, want);
  assert.deepEqual(new SettingsStore(new Store(join(dir, 'ak.db'))).get(), want);
});

test('a bad patch is refused as a whole and changes nothing', () => {
  const s = new SettingsStore(tempStore());
  for (const bad of [
    { onboarded: 'yes' },
    { suggest: { codex: 'no' } },
    { suggest: { gemini: false } },
    { showChats: [true] },
    { theme: 'dark' },
    { onboarded: true, suggest: { codex: 1 } },
  ]) {
    assert.throws(() => s.patch(bad as Record<string, unknown>), SettingsError);
  }
  assert.deepEqual(s.get(), defaultSettings());
});

test('stored junk falls back to the defaults', () => {
  const store = tempStore();
  store.setSetting('suggest', '{not json');
  store.setSetting('showChats', JSON.stringify({ claude: 'x', codex: false }));
  const s = new SettingsStore(store).get();
  assert.deepEqual(s.suggest, { claude: true, codex: true, antigravity: true });
  assert.deepEqual(s.showChats, { claude: true, codex: false, antigravity: true });
});

// ---- effect on the API ----

const reading = (provider: 'claude' | 'codex', left: number): UsageReading => ({
  provider, status: 'ok', readAt: '2026-01-01T00:00:00Z',
  windows: [{ kind: 'five_hour', label: '5-hour', leftPct: left, resetsAt: null }],
});
const hist: HistoryChat[] = [
  { provider: 'claude', sessionRef: 's1', title: 'a', cwd: '/p/one', updatedAt: '2026-01-02T00:00:00Z' },
  { provider: 'antigravity', sessionRef: 'g1', title: 'b', cwd: '/p/two', updatedAt: '2026-01-01T00:00:00Z' },
];

test('GET/PATCH /api/settings; "suggest" limits Most room; "showChats" filters history and projects', async () => {
  const settings = new SettingsStore(tempStore());
  const usage: any = { latest: () => [reading('claude', 40), reading('codex', 70)], refresh: async () => [] };
  const api = createApi({ chats: { listChats: () => [] } as any, usage, history: async () => hist, token: 'tok', settings });
  await new Promise<void>((r) => api.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  const f = (path: string, init: RequestInit = {}, token: string | null = 'tok') =>
    fetch(base + path, { ...init, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' } });
  const patch = (body: unknown) => f('/api/settings', { method: 'PATCH', body: JSON.stringify(body) });
  try {
    assert.equal((await f('/api/settings', {}, null)).status, 401);
    assert.equal((await patch({ onboarded: true }).then((r) => r.status)), 200);
    assert.equal(((await (await f('/api/settings')).json()) as Settings).onboarded, true);
    const bad = await patch({ suggest: { gemini: false } });
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: 'Unknown provider. Use claude, codex or antigravity.' });

    assert.equal(((await (await f('/api/usage')).json()) as { suggested: string }).suggested, 'codex');
    await patch({ suggest: { codex: false } });
    assert.equal(((await (await f('/api/usage')).json()) as { suggested: string }).suggested, 'claude');

    assert.equal(((await (await f('/api/history')).json()) as HistoryChat[]).length, 2);
    await patch({ showChats: { antigravity: false } });
    const shown = (await (await f('/api/history')).json()) as HistoryChat[];
    assert.deepEqual(shown.map((h) => h.provider), ['claude']);
    const projects = (await (await f('/api/projects')).json()) as Project[];
    assert.deepEqual(projects.map((p) => p.path), ['/p/one']);
  } finally {
    api.close(); api.server.closeAllConnections(); api.server.close();
  }
});

test('PATCH /api/settings broadcasts settings.updated so other open pages follow', async () => {
  const { WebSocket } = await import('ws');
  const settings = new SettingsStore(tempStore());
  const usage: any = { latest: () => [], refresh: async () => [] };
  const api = createApi({ chats: { listChats: () => [] } as any, usage, history: async () => [], token: 'tok', settings });
  await new Promise<void>((r) => api.server.listen(0, '127.0.0.1', r));
  const port = (api.server.address() as AddressInfo).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=tok`);
  try {
    await new Promise((r) => ws.on('open', r));
    const got = new Promise<any>((r) => ws.on('message', (d) => { const e = JSON.parse(String(d)); if (e.type === 'settings.updated') r(e); }));
    const res = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: 'PATCH', headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' }, body: JSON.stringify({ suggest: { codex: false } }),
    });
    const body = (await res.json()) as Settings;
    const e = await got;
    assert.deepEqual(e.settings, body);
    assert.equal(e.settings.suggest.codex, false);
  } finally {
    ws.terminate();
    api.close(); api.server.closeAllConnections(); api.server.close();
  }
});
