// What the tray shows and what Quit asks, as plain data (design/DESIGN.md, Desktop app). main.ts turns
// these into Electron's menu, icon and message box.
import type { DesktopStatus } from '@agent-kanban/shared';

export type TrayItem =
  | { kind: 'open'; label: string }
  | { kind: 'heading'; label: string }
  | { kind: 'chat'; id: string; label: string }
  | { kind: 'more'; label: string }
  | { kind: 'separator' }
  | { kind: 'login'; label: string; checked: boolean }
  | { kind: 'quit'; label: string };

const MAX_CHATS = 3;
const MAX_TITLE = 40;

const cut = (s: string) => (s.length > MAX_TITLE ? `${s.slice(0, MAX_TITLE - 1).trimEnd()}…` : s);

export function trayMenu(status: DesktopStatus, startAtLogin: boolean): TrayItem[] {
  const items: TrayItem[] = [{ kind: 'open', label: 'Open Agent Kanban' }];
  if (status.needsYou.length > 0) {
    items.push({ kind: 'heading', label: 'Needs you' });
    for (const c of status.needsYou.slice(0, MAX_CHATS)) items.push({ kind: 'chat', id: c.id, label: cut(c.title) });
    const more = status.needsYou.length - MAX_CHATS;
    if (more > 0) items.push({ kind: 'more', label: `+${more} more` });
  }
  items.push({ kind: 'separator' });
  items.push({ kind: 'login', label: 'Start at login', checked: startAtLogin });
  items.push({ kind: 'quit', label: 'Quit Agent Kanban' });
  return items;
}

/** The tray image's name: the single-colour mark for the taskbar's theme, with the amber dot when a chat needs you. */
export function trayIcon(status: DesktopStatus, darkTaskbar: boolean): string {
  return `tray-on-${darkTaskbar ? 'dark' : 'light'}${status.needsYou.length > 0 ? '-needs' : ''}`;
}

export function trayTooltip(status: DesktopStatus): string {
  const n = status.needsYou.length;
  return n === 0 ? 'Agent Kanban' : `Agent Kanban: ${n} ${n === 1 ? 'chat needs' : 'chats need'} you`;
}

/** The message box Quit shows while chats are running; null means quit straight away. */
export function quitPrompt(running: number): { message: string; detail: string; buttons: [string, string] } | null {
  if (running <= 0) return null;
  return {
    message: running === 1 ? '1 chat is running.' : `${running} chats are running.`,
    detail: running === 1 ? 'Quitting stops it.' : 'Quitting stops them.',
    buttons: ['Quit and stop chats', 'Cancel'],
  };
}
