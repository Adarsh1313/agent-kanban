import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { HistoryChat, Project } from '@agent-kanban/shared';
import { createApi } from '../src/api.ts';
import { SettingsStore } from '../src/settings.ts';
import { Store } from '../src/store.ts';

const h = (cwd: string, sessionRef: string, updatedAt = '2026-10-30T10:00:00.000Z'): HistoryChat => ({ provider: 'claude', sessionRef, title: sessionRef, cwd, updatedAt });
/** A folder that exists and is not under the temp folder. */
const real = process.cwd();
const temp = mkdtempSync(join(tmpdir(), 'ak-claude-'));

async function projectsFor(history: HistoryChat[], patch?: Record<string, unknown>) {
  const settings = new SettingsStore(new Store(join(mkdtempSync(join(tmpdir(), 'ak-vis-')), 'ak.db')));
  if (patch) settings.patch(patch);
  const usage: any = { latest: () => [], refresh: async () => [] };
  const api = createApi({ chats: { listChats: () => [] } as any, usage, history: async () => history, token: 'tok', settings });
  await new Promise<void>((r) => api.server.listen(0, '127.0.0.1', r));
  const { port } = api.server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/projects`, { headers: { Authorization: 'Bearer tok' } });
    return (await res.json()) as Project[];
  } finally { api.close(); api.server.closeAllConnections(); api.server.close(); }
}
const byPath = (ps: Project[], path: string) => ps.find((p) => p.path === path);

test('a project under the temp folder is hidden automatically; a normal one is not', async () => {
  const ps = await projectsFor([h(temp, 't1'), h(real, 'r1')]);
  assert.equal(byPath(ps, temp)?.hidden, 'auto');
  assert.equal(byPath(ps, temp)?.tempFolder, true);
  assert.equal(byPath(ps, real)?.hidden, null);
  assert.equal(byPath(ps, real)?.tempFolder, false);
});

test('a project the user hid is hidden "manual", however its folder is spelled', async () => {
  const other = join(real, 'apps');
  const ps = await projectsFor([h(real, 'r1'), h(other, 'o1')], { hiddenProjects: [real.toUpperCase() + '\\'] });
  assert.equal(byPath(ps, real)?.hidden, process.platform === 'win32' ? 'manual' : null);
  assert.equal(byPath(ps, other)?.hidden, null);
});

test('PATCH /api/settings refuses a hiddenProjects that is not a list of folders, and changes nothing', async () => {
  const settings = new SettingsStore(new Store(join(mkdtempSync(join(tmpdir(), 'ak-vis-')), 'ak.db')));
  const usage: any = { latest: () => [], refresh: async () => [] };
  const api = createApi({ chats: { listChats: () => [] } as any, usage, history: async () => [], token: 'tok', settings });
  await new Promise<void>((r) => api.server.listen(0, '127.0.0.1', r));
  const { port } = api.server.address() as AddressInfo;
  const patch = (body: unknown) => fetch(`http://127.0.0.1:${port}/api/settings`, { method: 'PATCH', headers: { Authorization: 'Bearer tok' }, body: JSON.stringify(body) });
  try {
    for (const bad of ['/work/a', [1], [''], null]) assert.equal((await patch({ hiddenProjects: bad, onboarded: true })).status, 400);
    assert.deepEqual(settings.get().hiddenProjects, []);
    assert.equal(settings.get().onboarded, false);
    assert.equal((await patch({ hiddenProjects: ['/work/a'] })).status, 200);
    assert.deepEqual(settings.get().hiddenProjects, ['/work/a']);
  } finally { api.close(); api.server.closeAllConnections(); api.server.close(); }
});

test('a project whose folder is gone is marked folder missing; one that exists is not', async () => {
  const gone = join(real, 'no-such-folder-' + Date.now());
  const ps = await projectsFor([h(gone, 'g1'), h(real, 'r1')]);
  assert.equal(byPath(ps, gone)?.folderMissing, true);
  assert.equal(byPath(ps, real)?.folderMissing, false);
});

test("the Claude app's scratch folders are one project, \"Claude scratch chats\"", async () => {
  const root = join(real, 'AppData', 'Roaming', 'Claude', 'scratch-workspaces');
  const ps = await projectsFor([h(join(root, 'u1', 'scratch-aa'), 's1', '2026-10-30T09:00:00.000Z'), h(join(root, 'u2', 'scratch-bb'), 's2'), h(real, 'r1')]);
  const scratch = ps.filter((p) => p.name === 'Claude scratch chats');
  assert.equal(scratch.length, 1);
  assert.equal(scratch[0]!.path, root);
  assert.equal(scratch[0]!.historyOnly, 2);
  assert.equal(scratch[0]!.lastActivityAt, '2026-10-30T10:00:00.000Z');
  assert.equal(scratch[0]!.hidden, null);
  assert.equal(scratch[0]!.folderMissing, false);
  assert.equal(ps.length, 2);
});

test('an auto-hidden project the user unhid is shown, and hiding it again wins', async () => {
  let ps = await projectsFor([h(temp, 't1')], { unhiddenProjects: [temp] });
  assert.equal(byPath(ps, temp)?.hidden, null);
  ps = await projectsFor([h(temp, 't1')], { unhiddenProjects: [temp], hiddenProjects: [temp] });
  assert.equal(byPath(ps, temp)?.hidden, 'manual');
});

test('only scratch-* folders under scratch-workspaces count as Claude scratch chats', async () => {
  const root = join(real, 'AppData', 'Roaming', 'Claude', 'scratch-workspaces');
  const other = join(root, 'u1', 'not-a-scratch');
  const ps = await projectsFor([h(join(root, 'u1', 'scratch-aa'), 's1'), h(other, 'o1')]);
  assert.equal(ps.filter((p) => p.name === 'Claude scratch chats').length, 1);
  assert.ok(byPath(ps, other));
});
