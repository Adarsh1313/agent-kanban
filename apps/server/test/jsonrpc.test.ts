import { test } from 'node:test';
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
