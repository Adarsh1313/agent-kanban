import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { ServerEvent } from '@agent-kanban/shared';
import { Store } from '../src/store.ts';
import { createApi } from '../src/api.ts';
import { ClaudeHooks, HOOK_EVENTS } from '../src/outside/hooks.ts';
import { IDLE_MS, OutsideSessions } from '../src/outside/sessions.ts';

const temp = () => mkdtempSync(join(tmpdir(), 'ak-outside-'));
const USER_HOOK = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] };

function hooksIn(dir: string) {
  const settingsPath = join(dir, '.claude', 'settings.json');
  const hooks = new ClaudeHooks({ settingsPath, scriptPath: join(dir, 'ak', 'agent-kanban-hook.mjs'), endpointPath: join(dir, 'ak', 'hook-endpoint.json'), runner: `"${process.execPath}"` });
  return { settingsPath, hooks };
}

test('install adds one entry per event next to the user hooks; remove restores the file', () => {
  const dir = temp();
  const { settingsPath, hooks } = hooksIn(dir);
  mkdirSync(join(dir, '.claude'));
  const before = { model: 'opus', hooks: { PreToolUse: [USER_HOOK], Stop: [USER_HOOK] } };
  writeFileSync(settingsPath, JSON.stringify(before));
  assert.equal(hooks.installed(), false);
  hooks.install();
  hooks.install(); // twice still means one entry each
  assert.equal(hooks.installed(), true);
  const after = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(after.model, 'opus');
  assert.deepEqual(after.hooks.PreToolUse, [USER_HOOK]);
  for (const ev of HOOK_EVENTS) {
    const ours = after.hooks[ev].filter((g: any) => g.hooks[0].command.includes('agent-kanban-hook.mjs'));
    assert.equal(ours.length, 1, ev);
  }
  assert.deepEqual(after.hooks.Stop[0], USER_HOOK);
  hooks.remove();
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, 'utf8')), before);
  assert.equal(hooks.installed(), false);
});

test('install creates settings.json when missing; an entry removed by hand reads as not installed', () => {
  const dir = temp();
  const { settingsPath, hooks } = hooksIn(dir);
  hooks.install();
  assert.equal(hooks.installed(), true);
  const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
  delete s.hooks.Notification;
  writeFileSync(settingsPath, JSON.stringify(s));
  assert.equal(hooks.installed(), false);
});

test('a settings file that is not JSON is never rewritten', () => {
  const dir = temp();
  const { settingsPath, hooks } = hooksIn(dir);
  mkdirSync(join(dir, '.claude'));
  writeFileSync(settingsPath, '{ not json');
  assert.throws(() => hooks.install());
  assert.equal(readFileSync(settingsPath, 'utf8'), '{ not json');
});

test('the hook script exits 0 quickly when the app is not running', () => {
  const dir = temp();
  const { hooks } = hooksIn(dir);
  hooks.install();
  const started = Date.now();
  const r = spawnSync(process.execPath, [join(dir, 'ak', 'agent-kanban-hook.mjs'), join(dir, 'ak', 'hook-endpoint.json')], { input: '{"hook_event_name":"Stop"}' });
  assert.equal(r.status, 0);
  assert.ok(Date.now() - started < 3000);
});

async function setup(opts: { runningHere?: (id: string) => boolean; now?: () => number } = {}) {
  const dir = temp();
  const store = new Store(join(dir, 'ak.db'));
  const events: ServerEvent[] = [];
  let emit: (e: ServerEvent) => void = () => {};
  const claudeHome = join(dir, '.claude');
  const outside = new OutsideSessions({ store, emit: (e) => emit(e), runningHere: opts.runningHere ?? (() => false), claudeHome, now: opts.now });
  const { hooks } = hooksIn(dir);
  const chats: any = { listChats: () => store.listChats() };
  const usage: any = { latest: () => [], refresh: async () => [] };
  const api = createApi({ chats, usage, history: async () => [], token: 'tok', hooks, outside, hookSecret: 'sec' });
  emit = (e) => { events.push(e); api.broadcast(e); };
  await new Promise<void>((r) => api.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  const hook = (body: unknown, headers: Record<string, string> = { 'X-Agent-Kanban-Hook': 'sec' }) =>
    fetch(base + '/api/hooks/claude/event', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const close = () => { api.close(); api.server.closeAllConnections(); api.server.close(); };
  return { dir, store, events, base, hook, outside, claudeHome, close };
}

const ev = (name: string, extra: Record<string, unknown> = {}) => ({ hook_event_name: name, session_id: 'abc-123', cwd: '/work/site', ...extra });

test('hook events move one outside chat Running → Needs you → Review', async () => {
  const s = await setup();
  try {
    assert.equal((await s.hook(ev('SessionStart'))).status, 204);
    let [chat] = s.store.listChats();
    assert.equal(chat!.column, 'running');
    assert.equal(chat!.origin, 'outside');
    assert.equal(chat!.outsideLive, true);
    await s.hook(ev('UserPromptSubmit', { prompt: 'Fix the footer links\nand more' }));
    assert.equal(s.store.listChats()[0]!.title, 'Fix the footer links');
    await s.hook(ev('Notification', { message: 'Claude needs your permission to use Bash' }));
    chat = s.store.listChats()[0];
    assert.equal(chat!.column, 'needs_you');
    assert.equal(chat!.needsReason, 'permission');
    await s.hook(ev('Notification', { message: 'Claude is waiting for your input' }));
    assert.equal(s.store.listChats()[0]!.needsReason, 'waiting');
    await s.hook(ev('Stop'));
    chat = s.store.listChats()[0];
    assert.equal(chat!.column, 'review');
    assert.equal(chat!.outsideLive, false);
    assert.equal(s.store.listChats().length, 1);
    await s.hook(ev('Notification', { message: 'Claude is waiting for your input' }));
    assert.equal(s.store.listChats()[0]!.column, 'review', 'idle reminder after Stop is ignored');
    const kinds = s.events.filter((e) => e.type === 'notification').map((e) => (e as { kind: string }).kind);
    assert.deepEqual(kinds, ['permission', 'question', 'finished']);
  } finally { s.close(); }
});

test('the event endpoint refuses a wrong secret, a web page, and an unknown shape', async () => {
  const s = await setup();
  try {
    assert.equal((await s.hook(ev('Stop'), {})).status, 401);
    assert.equal((await s.hook(ev('Stop'), { 'X-Agent-Kanban-Hook': 'nope' })).status, 401);
    assert.equal((await s.hook(ev('Stop'), { 'X-Agent-Kanban-Hook': 'sec', Origin: 'http://evil.example' })).status, 401);
    assert.equal((await s.hook({ hook_event_name: 'PreToolUse', session_id: 'x', cwd: '/a' })).status, 400);
    assert.equal((await s.hook({ hook_event_name: 'Stop', session_id: '../../etc', cwd: '/a' })).status, 400);
    assert.equal(s.store.listChats().length, 0);
  } finally { s.close(); }
});

test('a chat the app is running itself is left alone', async () => {
  const s = await setup({ runningHere: () => true });
  try {
    const own = s.store.createChat({ provider: 'claude', cwd: '/work/site', title: 'Mine', sessionRef: 'abc-123' });
    await s.hook(ev('Stop'));
    const chat = s.store.getChat(own.id)!;
    assert.equal(chat.column, 'running');
    assert.equal(chat.origin, undefined);
  } finally { s.close(); }
});

test('GET, install and remove report the state and broadcast it', async () => {
  const s = await setup();
  try {
    const f = (path: string, method = 'GET') => fetch(s.base + path, { method, headers: { Authorization: 'Bearer tok' } }).then((r) => r.json());
    assert.deepEqual(await f('/api/hooks/claude'), { installed: false });
    assert.deepEqual(await f('/api/hooks/claude/install', 'POST'), { installed: true });
    assert.deepEqual(await f('/api/hooks/claude'), { installed: true });
    assert.deepEqual(await f('/api/hooks/claude/remove', 'POST'), { installed: false });
    assert.equal((await fetch(s.base + '/api/hooks/claude')).status, 401);
  } finally { s.close(); }
});

test('catch-up adds recent sessions once, settled by age; idle live chats settle to Review', async () => {
  const now = Date.now();
  let clock = now;
  const s = await setup({ now: () => clock });
  try {
    const proj = join(s.claudeHome, 'projects', 'site');
    mkdirSync(proj, { recursive: true });
    const file = (id: string, ageMs: number) => {
      const p = join(proj, `${id}.jsonl`);
      writeFileSync(p, '');
      const t = (now - ageMs) / 1000;
      utimesSync(p, t, t);
    };
    file('fresh', 60_000);
    file('idle', IDLE_MS + 60_000);
    file('old', 2 * 24 * 60 * 60_000);
    const read = async (_p: string, ref: string) => ({ title: `Chat ${ref}`, cwd: '/work/site' });
    await s.outside.catchUp(read);
    await s.outside.catchUp(read);
    const byRef = Object.fromEntries(s.store.listChats().map((c) => [c.sessionRef, c]));
    assert.deepEqual(Object.keys(byRef).sort(), ['fresh', 'idle']);
    assert.equal(byRef.fresh!.column, 'running');
    assert.equal(byRef.idle!.column, 'review');
    clock = now + IDLE_MS + 5_000;
    s.outside.settleIdle();
    const fresh = s.store.findBySessionRef('claude', 'fresh')!;
    assert.equal(fresh.column, 'review');
    assert.equal(fresh.outsideLive, false);
  } finally { s.close(); }
});
