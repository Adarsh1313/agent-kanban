import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpawnTarget } from '../src/adapters/spawn-target.ts';

const dir = fileURLToPath(new URL('./fixtures/shims', import.meta.url));

test('node shim resolves to node + script', () => {
  const file = path.join(dir, 'codex.cmd');
  const t = resolveSpawnTarget(file, 'win32');
  assert.equal(t.command, process.execPath);
  assert.deepEqual(t.args, [path.win32.join(path.win32.dirname(file), 'node_modules\\@openai\\codex\\bin\\codex.js')]);
});

test('exe shim resolves to the exe', () => {
  const file = path.join(dir, 'claude.cmd');
  const t = resolveSpawnTarget(file, 'win32');
  assert.deepEqual(t, { command: path.win32.join(path.win32.dirname(file), 'node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'), args: [] });
});

test('non-windows, non-shim and unreadable paths pass through', () => {
  const file = path.join(dir, 'codex.cmd');
  assert.deepEqual(resolveSpawnTarget(file, 'linux'), { command: file, args: [] });
  assert.deepEqual(resolveSpawnTarget('C:\\x\\codex.exe', 'win32'), { command: 'C:\\x\\codex.exe', args: [] });
  assert.deepEqual(resolveSpawnTarget('C:\\nope\\missing.cmd', 'win32'), { command: 'C:\\nope\\missing.cmd', args: [] });
});
