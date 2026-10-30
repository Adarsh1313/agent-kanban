// Messages between the desktop app and the things it hosts: the server child process (over its IPC
// channel) and the web app (over the preload bridge). Browser mode uses neither.

/** Server → desktop app. */
export type ServerToDesktop =
  | { type: 'ready'; port: number; token: string }
  /** `locked`: another Agent Kanban (usually browser mode) holds the data folder. */
  | { type: 'failed'; reason: 'locked' | 'other'; message: string };

/** Desktop app → server. `stop` runs the server's graceful shutdown, which ends every chat. */
export type DesktopToServer = { type: 'stop' };

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
