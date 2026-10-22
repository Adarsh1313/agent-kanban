import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdapterRegistry } from '../src/adapters/registry.ts';
import type { ProviderAdapter } from '../src/adapters/adapter.ts';

function fakeAdapter(path: string, idle = true) {
  return { path, idle, disposed: 0, isIdle() { return this.idle; }, async dispose() { this.disposed++; } };
}

test('a changed binary path swaps in a new adapter and disposes the old one once idle', async () => {
  const made: ReturnType<typeof fakeAdapter>[] = [];
  const seen: unknown[] = [];
  const reg = new AdapterRegistry({ findBinary: async () => null, create: (_id, path) => { const a = fakeAdapter(path); made.push(a); return a as unknown as ProviderAdapter; } });
  reg.onAdapter((_id, a) => seen.push(a));
  const first = await reg.ensure('codex', 'C:\\old\\codex.exe');
  assert.equal(await reg.ensure('codex', 'C:\\old\\codex.exe'), first);
  made[0]!.idle = false;
  assert.equal(await reg.ensure('codex', 'C:\\new\\codex.exe'), first, 'busy: keep the old adapter');
  assert.equal(made.length, 1);
  made[0]!.idle = true;
  const second = await reg.ensure('codex', 'C:\\new\\codex.exe');
  assert.notEqual(second, first);
  assert.equal(reg.get('codex'), second);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(made[0]!.disposed, 1);
  assert.equal(seen.length, 2, 'listeners hear about the new adapter');
});

test('a create() that throws gives undefined instead of an unhandled rejection', async () => {
  const reg = new AdapterRegistry({ findBinary: async () => 'x', create: () => { throw new Error('boom'); } });
  const orig = console.error;
  console.error = () => {};
  try {
    assert.equal(await reg.ensure('codex'), undefined);
    assert.equal(await reg.ensure('codex', 'y'), undefined);
  } finally { console.error = orig; }
});
