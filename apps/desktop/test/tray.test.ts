import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { quitPrompt, trayIcon, trayMenu, trayTooltip } from '../src/tray.ts';
import { loadState, noteFirstClose, saveState } from '../src/state.ts';

const chats = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i + 1}`, title: `Chat ${i + 1}` }));
const labels = (items: ReturnType<typeof trayMenu>) => items.map((i) => (i.kind === 'separator' ? '---' : i.label));

test('nothing needs you: open, start at login, quit', () => {
  assert.deepEqual(labels(trayMenu({ needsYou: [], running: 0 }, false)), ['Open Agent Kanban', '---', 'Start at login', 'Quit Agent Kanban']);
});

test('chats that need you are listed by title under a "Needs you" label', () => {
  const items = trayMenu({ needsYou: chats(1), running: 0 }, false);
  assert.deepEqual(labels(items), ['Open Agent Kanban', 'Needs you', 'Chat 1', '---', 'Start at login', 'Quit Agent Kanban']);
  assert.deepEqual(items[2], { kind: 'chat', id: 'c1', label: 'Chat 1' });
});

test('at most three chats are listed, then "+N more"', () => {
  assert.deepEqual(labels(trayMenu({ needsYou: chats(3), running: 0 }, false)).slice(1, 5), ['Needs you', 'Chat 1', 'Chat 2', 'Chat 3']);
  assert.deepEqual(labels(trayMenu({ needsYou: chats(5), running: 0 }, false)).slice(1, 6), ['Needs you', 'Chat 1', 'Chat 2', 'Chat 3', '+2 more']);
});

test('long titles are cut with an ellipsis', () => {
  const items = trayMenu({ needsYou: [{ id: 'a', title: 'Add a sign-up page to the bakery site with email confirmation' }], running: 0 }, false);
  assert.equal(items[2].kind === 'chat' && items[2].label, 'Add a sign-up page to the bakery site w…');
});

test('Start at login shows its state as a checkmark', () => {
  const on = trayMenu({ needsYou: [], running: 0 }, true).find((i) => i.kind === 'login');
  const off = trayMenu({ needsYou: [], running: 0 }, false).find((i) => i.kind === 'login');
  assert.deepEqual([on?.kind === 'login' && on.checked, off?.kind === 'login' && off.checked], [true, false]);
});

test('the tray icon matches the taskbar and gets the amber dot only when a chat needs you', () => {
  assert.equal(trayIcon({ needsYou: [], running: 3 }, true), 'tray-on-dark');
  assert.equal(trayIcon({ needsYou: chats(1), running: 0 }, true), 'tray-on-dark-needs');
  assert.equal(trayIcon({ needsYou: chats(2), running: 0 }, false), 'tray-on-light-needs');
});

test('the tray tooltip says how many chats need you', () => {
  assert.equal(trayTooltip({ needsYou: [], running: 0 }), 'Agent Kanban');
  assert.equal(trayTooltip({ needsYou: chats(1), running: 0 }), 'Agent Kanban: 1 chat needs you');
  assert.equal(trayTooltip({ needsYou: chats(2), running: 0 }), 'Agent Kanban: 2 chats need you');
});

test('Quit asks first only while chats are running, and says how many stop', () => {
  assert.equal(quitPrompt(0), null);
  assert.deepEqual(quitPrompt(1), { message: '1 chat is running.', detail: 'Quitting stops it.', buttons: ['Quit and stop chats', 'Cancel'] });
  assert.deepEqual(quitPrompt(2), { message: '2 chats are running.', detail: 'Quitting stops them.', buttons: ['Quit and stop chats', 'Cancel'] });
});

test('the first-close note shows once, also across restarts', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'ak-state-')), 'desktop.json');
  const first = loadState(path);
  assert.equal(noteFirstClose(first), true);
  assert.equal(noteFirstClose(first), false);
  saveState(path, first);
  assert.equal(noteFirstClose(loadState(path)), false);
});
