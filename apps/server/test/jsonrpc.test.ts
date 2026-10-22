import { test } from 'node:test';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { JsonRpcProcess } from '../src/adapters/jsonrpc.ts';

test('pending requests are rejected when the process exits', async () => {
  const p = new JsonRpcProcess(process.execPath, ['-e', 'process.stdin.once("data", () => process.exit(0))']);
  await assert.rejects(p.request('anything', {}), /exited/);
  await p.close();
});

test('request times out', async () => {
  const p = new JsonRpcProcess(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { requestTimeoutMs: 100 });
  try {
    await assert.rejects(p.request('anything', {}), /timed out/);
  } finally { await p.close(); }
});

test('framing: split chunks and several messages per chunk', async () => {
  const script = `
    process.stdout.write('{"method":"a","para');
    setTimeout(() => process.stdout.write('ms":1}\\n{"method":"b","params":2}\\n{"method":"c"'), 50);
    setTimeout(() => process.stdout.write(',"params":3}\\n'), 100);
    setTimeout(() => process.exit(0), 300);
  `;
  const p = new JsonRpcProcess(process.execPath, ['-e', script]);
  const got: Array<[string, unknown]> = [];
  p.onNotification((m, params) => got.push([m, params]));
  await new Promise<void>((r) => p.onExit(() => r()));
  assert.deepEqual(got, [['a', 1], ['b', 2], ['c', 3]]);
});

test('close kills a running process', async () => {
  const p = new JsonRpcProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  await p.close();
  await assert.rejects(p.request('x', {}), /exited/);
});

test('a request timeout makes the process suspect and any notification clears it', async () => {
  const script = 'setTimeout(() => console.log(JSON.stringify({ method: "hello", params: {} })), 300); setTimeout(() => {}, 5000)';
  const p = new JsonRpcProcess(process.execPath, ['-e', script], { requestTimeoutMs: 50 });
  try {
    assert.equal(p.suspect, false);
    await assert.rejects(p.request('anything', {}), /timed out/);
    assert.equal(p.suspect, true);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(p.suspect, false, 'a notification arrived');
  } finally { await p.close(); }
});

test('close falls back to child.kill() when taskkill exits non-zero', async () => {
  const failing = () => spawn(process.execPath, ['-e', 'process.exit(1)'], { stdio: 'ignore' });
  const p = new JsonRpcProcess(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { taskkill: failing });
  let exited = false;
  p.onExit(() => { exited = true; });
  const t0 = Date.now();
  await p.close();
  assert.ok(Date.now() - t0 < 3000, 'close should not wait for the 5 s cap');
  assert.equal(exited, true);
});
