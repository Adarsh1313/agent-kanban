import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLock, processAlive, releaseLock } from '../src/lock.ts';

const lockIn = () => join(mkdtempSync(join(tmpdir(), 'ak-lock-')), 'server.lock');

test('acquireLock writes our pid; a live holder refuses a second instance', () => {
  const path = lockIn();
  assert.equal(acquireLock(path, 100, () => true), true);
  assert.equal(readFileSync(path, 'utf8'), '100');
  assert.equal(acquireLock(path, 200, (pid) => pid === 100), false);
  assert.equal(readFileSync(path, 'utf8'), '100');
  assert.equal(acquireLock(path, 100, () => true), true, 'our own lock is ours');
});

test('a stale lock (dead pid) or a garbled one is taken over', () => {
  const path = lockIn();
  writeFileSync(path, '100');
  assert.equal(acquireLock(path, 200, () => false), true);
  assert.equal(readFileSync(path, 'utf8'), '200');
  writeFileSync(path, 'not a pid');
  assert.equal(acquireLock(path, 300, () => true), true);
  assert.equal(readFileSync(path, 'utf8'), '300');
});

test('releaseLock removes only our own lock', () => {
  const path = lockIn();
  acquireLock(path, 100, () => true);
  releaseLock(path, 200);
  assert.ok(existsSync(path));
  releaseLock(path, 100);
  assert.ok(!existsSync(path));
  releaseLock(path, 100); // already gone: no throw
});

test('processAlive: this process is alive, a nonsense pid is not', () => {
  assert.equal(processAlive(process.pid), true);
  assert.equal(processAlive(0), false);
  assert.equal(processAlive(-5), false);
});

test('the server refuses to start while another live instance holds the lock', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ak-home-'));
  mkdirSync(join(home, '.agent-kanban'));
  writeFileSync(join(home, '.agent-kanban', 'server.lock'), String(process.pid)); // this test process is alive
  const main = fileURLToPath(new URL('../src/main.ts', import.meta.url));
  const r = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = execFile(process.execPath, ['--disable-warning=ExperimentalWarning', main], {
      env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 20_000, windowsHide: true,
    }, (_err, _out, stderr) => resolve({ code: child.exitCode, stderr: String(stderr) }));
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Agent Kanban is already running\./);
  assert.equal(readFileSync(join(home, '.agent-kanban', 'server.lock'), 'utf8'), String(process.pid), 'the other instance keeps its lock');
});
