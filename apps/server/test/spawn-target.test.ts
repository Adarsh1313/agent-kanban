import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpawnTarget, scriptRunner } from '../src/adapters/spawn-target.ts';

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

test('inside the desktop app, scripts run on a console node.exe from PATH, never on the windowed app itself', () => {
  const node = String.raw`C:\Program Files\nodejs\node.exe`;
  const exists = (p: string) => p === node;
  const PATH = String.raw`C:\Windows;C:\Program Files\nodejs\;C:\Users\a\AppData\Roaming\npm`;
  assert.equal(scriptRunner({ electron: true, path: PATH, exists, execPath: String.raw`C:\Apps\Agent Kanban.exe` }), node);
});

test('inside the desktop app with no node.exe on PATH, the app runs scripts itself (last resort)', () => {
  const app = String.raw`C:\Apps\Agent Kanban.exe`;
  assert.equal(scriptRunner({ electron: true, path: String.raw`C:\Windows`, exists: () => false, execPath: app }), app);
});

test('in browser mode the server is plain Node, so scripts run on the same node', () => {
  const node = String.raw`C:\node\node.exe`;
  assert.equal(scriptRunner({ electron: false, path: String.raw`C:\Program Files\nodejs`, exists: () => true, execPath: node }), node);
});
