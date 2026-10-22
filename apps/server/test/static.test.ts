import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../src/api.ts';

async function setup(withDist: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'ak-static-'));
  const dist = join(root, 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  mkdirSync(join(dist, 'providers'), { recursive: true });
  if (withDist) writeFileSync(join(dist, 'index.html'), '<!doctype html><title>SPA shell</title>');
  writeFileSync(join(dist, 'assets', 'x.js'), 'console.log(1)');
  writeFileSync(join(dist, 'providers', 'claude.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(root, 'secret.txt'), 'secret');
  const chats: any = { listChats: () => [] };
  const api = createApi({ chats, usage: {} as any, history: async () => [], token: 'tok', webDist: dist });
  await new Promise<void>((r) => api.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  const get = (path: string, headers: Record<string, string> = {}) => fetch(base + path, { headers });
  return { get, close: () => { api.close(); api.server.closeAllConnections(); api.server.close(); } };
}
const HTML = { Accept: 'text/html' };

test('/assets/* is served without a token, immutable, with the right type', async () => {
  const s = await setup(true);
  try {
    const r = await s.get('/assets/x.js');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.match(r.headers.get('content-type') ?? '', /javascript/);
    assert.equal(await r.text(), 'console.log(1)');
    const svg = await s.get('/providers/claude.svg');
    assert.equal(svg.status, 200);
    assert.equal(svg.headers.get('content-type'), 'image/svg+xml');
  } finally { s.close(); }
});

test('GET / serves the SPA shell when dist exists, else the console', async () => {
  const withDist = await setup(true);
  try {
    const r = await withDist.get('/?token=tok', HTML);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /SPA shell/);
    // the console stays reachable
    assert.match(await (await withDist.get('/console?token=tok', HTML)).text(), /Agent Kanban Server/);
    assert.equal((await withDist.get('/console', HTML)).status, 401);
    assert.equal((await withDist.get('/console?token=bad', HTML)).status, 401);
    // plain-text behaviour is unchanged
    assert.equal(await (await withDist.get('/?token=tok')).text(), 'Agent Kanban server is running.');
  } finally { withDist.close(); }
  const without = await setup(false);
  try {
    assert.match(await (await without.get('/?token=tok', HTML)).text(), /Agent Kanban Server/);
    assert.equal((await without.get('/?token=bad', HTML)).status, 401);
    assert.equal((await without.get('/some/page', HTML)).status, 401);
  } finally { without.close(); }
});

test('unknown non-api paths asking for HTML get the shell without a token; api paths do not', async () => {
  const s = await setup(true);
  try {
    assert.match(await (await s.get('/board/chat-1', HTML)).text(), /SPA shell/);
    assert.equal((await s.get('/api/nope', HTML)).status, 401);
    assert.equal((await s.get('/board/chat-1')).status, 401);
  } finally { s.close(); }
});

test('paths outside dist are never served as files', async () => {
  const s = await setup(true);
  try {
    for (const p of ['/assets/../../package.json', '/assets/%2e%2e/%2e%2e/package.json', '/assets/..%2f..%2fsecret.txt', '/assets/%2e%2e%2f%2e%2e%2fsecret.txt', '/..%5csecret.txt', '/assets/%00']) {
      const r = await s.get(p);
      assert.notEqual(r.status, 200, p);
      assert.doesNotMatch(await r.text(), /secret|"name"/, p);
    }
    // asking for HTML falls back to the shell, never the file
    const r = await s.get('/assets/..%2f..%2fsecret.txt', HTML);
    assert.doesNotMatch(await r.text(), /secret/);
  } finally { s.close(); }
});
