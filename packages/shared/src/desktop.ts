// Messages between the desktop app and the things it hosts: the server child process (over its IPC
// channel) and the web app (over the preload bridge). Browser mode uses neither.
import type { ApiKey, KeyProvider } from './types.ts';

/**
 * What the server asks the desktop app's key store (#43). Keys are encrypted and kept by the main process;
 * the server holds metadata only and asks for a key's value just before it starts a provider with it.
 */
export type KeyRequest =
  | { op: 'list' }
  | { op: 'add'; provider: KeyProvider; name: string; key: string }
  | { op: 'update'; id: string; patch: Partial<Pick<ApiKey, 'name' | 'capUsd' | 'spentUsd' | 'month'>> }
  | { op: 'remove'; id: string }
  | { op: 'reveal'; id: string };

/** The key store's answer; `result` is ApiKey[] (list), ApiKey (add), ApiKey | null (update), boolean (remove), string | null (reveal). */
export type KeyReply = { ok: true; result: unknown } | { ok: false; error: string };

/** Server → desktop app. */
export type ServerToDesktop =
  | { type: 'ready'; port: number; token: string }
  /** `locked`: another Agent Kanban (usually browser mode) holds the data folder. */
  | { type: 'failed'; reason: 'locked' | 'other'; message: string }
  | { type: 'keys'; reqId: number; request: KeyRequest };

/** Desktop app → server. `stop` runs the server's graceful shutdown, which ends every chat. */
export type DesktopToServer = { type: 'stop' } | ({ type: 'keys.reply'; reqId: number } & KeyReply);

/** What the tray needs to know, sent by the web app whenever it changes. */
export interface DesktopStatus {
  needsYou: { id: string; title: string }[];
  running: number;
}

/** The bridge the preload script puts on `window.agentKanbanDesktop`; absent in browser mode. */
export interface DesktopBridge {
  status(status: DesktopStatus): void;
  /** Brings the window forward (from the tray if it was hidden). */
  show(): void;
  /** Tells the app the page's current theme, so the title bar buttons can match it. */
  theme(theme: 'light' | 'dark'): void;
  /** Called by the app when the user picks a chat in the tray menu. Returns an unsubscribe function. */
  onOpenChat(listener: (chatId: string) => void): () => void;
}
