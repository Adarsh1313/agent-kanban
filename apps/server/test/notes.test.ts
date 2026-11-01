import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store.ts';
import { SettingsStore } from '../src/settings.ts';
import { createApi } from '../src/api.ts';

test('turning project notes on writes the notes file and managed lines; off removes the lines and keeps the file', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ak-notes-'));
  writeFileSync(join(cwd, 'CLAUDE.md'), 'My rules.\n');
  const dir = mkdtempSync(join(tmpdir(), 'ak-notes-db-'));
  const settings = new SettingsStore(new Store(join(dir, 'ak.db')));
  const history = async () => [{ provider: 'claude' as const, sessionRef: 's', title: 't', cwd, updatedAt: '2026-01-01T00:00:00Z' }];
  const api = createApi({ chats: { listChats: () => [] } as any, usage: { latest: () => [] } as any, history, token: 'tok', settings });
  await new Promise<void>((r) => api.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  const f = (method: string, path: string, body?: unknown) => fetch(base + path, { method, headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  try {
    const on = await f('POST', '/api/projects/notes', { path: cwd, on: true });
    assert.equal(on.status, 200);
    assert.deepEqual(((await on.json()) as any).notesProjects, [cwd]);
    assert.ok(existsSync(join(cwd, '.agent-kanban', 'notes.md')));
    for (const file of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']) assert.match(readFileSync(join(cwd, file), 'utf8'), /\.agent-kanban\/notes\.md/);
    assert.match(readFileSync(join(cwd, 'CLAUDE.md'), 'utf8'), /^My rules\./);

    assert.equal((await f('PUT', '/api/projects/notes', { path: cwd, text: 'Use pnpm.' })).status, 200);
    assert.deepEqual(await (await f('GET', `/api/projects/notes?path=${encodeURIComponent(cwd)}`)).json(), { text: 'Use pnpm.' });

    await f('POST', '/api/projects/notes', { path: cwd, on: false });
    assert.equal(readFileSync(join(cwd, 'CLAUDE.md'), 'utf8'), 'My rules.\n');
    assert.ok(!/notes\.md/.test(readFileSync(join(cwd, 'AGENTS.md'), 'utf8')));
    assert.equal(readFileSync(join(cwd, '.agent-kanban', 'notes.md'), 'utf8'), 'Use pnpm.');
    assert.deepEqual(settings.get().notesProjects, []);
    assert.equal((await f('POST', '/api/projects/notes', { path: '/not/a/project', on: true })).status, 404);
  } finally {
    api.close(); api.server.closeAllConnections(); api.server.close();
  }
});
