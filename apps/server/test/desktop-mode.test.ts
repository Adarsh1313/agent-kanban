// The server as the desktop app starts it: a child process with an IPC channel, its own home folder,
// and no provider binaries on PATH (so nothing real is touched).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerToDesktop } from '@agent-kanban/shared';

const MAIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main.ts');

function startServer(home = mkdtempSync(join(tmpdir(), 'ak-desktop-'))): { child: ChildProcess; home: string; output: () => string } {
  let output = '';
  const child = fork(MAIN, [], {
    execArgv: ['--disable-warning=ExperimentalWarning'],
    env: {
      SystemRoot: process.env.SystemRoot, PATH: dirname(process.execPath),
      USERPROFILE: home, HOME: home, AGENT_KANBAN_HOME: home, AGENT_KANBAN_DESKTOP: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout!.on('data', (d) => { output += d; });
  child.stderr!.on('data', (d) => { output += d; });
  return { child, home, output: () => output };
}

const firstMessage = (child: ChildProcess, timeoutMs = 20_000) => new Promise<ServerToDesktop>((resolve, reject) => {
  const t = setTimeout(() => { child.kill(); reject(new Error('no message from the server')); }, timeoutMs);
  child.once('message', (m) => { clearTimeout(t); resolve(m as ServerToDesktop); });
  child.once('exit', (code) => { clearTimeout(t); reject(new Error(`server exited (${code}) before sending a message`)); });
});

const exitCode = (child: ChildProcess, timeoutMs = 20_000) => new Promise<number | null>((resolve, reject) => {
  if (child.exitCode !== null) return resolve(child.exitCode);
  const t = setTimeout(() => { child.kill(); reject(new Error('server did not exit')); }, timeoutMs);
  child.once('exit', (code) => { clearTimeout(t); resolve(code); });
});

test('reports ready with a port that accepts its token, and never prints the token', async (t) => {
  const { child, output } = startServer();
  t.after(() => child.kill());
  const msg = await firstMessage(child);
  assert.equal(msg.type, 'ready');
  if (msg.type !== 'ready') return;
  assert.ok(msg.port > 0);
  const ok = await fetch(`http://127.0.0.1:${msg.port}/api/chats`, { headers: { authorization: `Bearer ${msg.token}` } });
  assert.equal(ok.status, 200);
  const denied = await fetch(`http://127.0.0.1:${msg.port}/api/chats`);
  assert.equal(denied.status, 401);
  assert.equal(output().includes(msg.token), false);
});

test('a stop message shuts the server down cleanly', async () => {
  const { child } = startServer();
  const msg = await firstMessage(child);
  assert.equal(msg.type, 'ready');
  child.send({ type: 'stop' });
  assert.equal(await exitCode(child), 0);
});

test('the server stops when the desktop app goes away (its IPC channel closes)', async () => {
  const { child } = startServer();
  await firstMessage(child);
  child.disconnect();
  assert.equal(await exitCode(child), 0);
});

test('reports failed: locked when another Agent Kanban holds the data folder', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ak-desktop-'));
  mkdirSync(join(home, '.agent-kanban'), { recursive: true });
  // Our own pid is alive, so the lock is held.
  writeFileSync(join(home, '.agent-kanban', 'server.lock'), String(process.pid));
  const { child } = startServer(home);
  const msg = await firstMessage(child);
  assert.deepEqual({ type: msg.type, reason: msg.type === 'failed' ? msg.reason : null }, { type: 'failed', reason: 'locked' });
  assert.equal(await exitCode(child), 1);
});
