export type ProviderId = 'claude' | 'codex' | 'antigravity';

export type Column = 'running' | 'needs_you' | 'review' | 'done';

export type NeedsReason = 'permission' | 'question' | 'limit' | 'error' | 'interrupted' | 'stopped';

export interface ChatState {
  column: Column;
  needsReason: NeedsReason | null;
}

export type AdapterEvent =
  | { type: 'session.started'; sessionRef: string }
  | { type: 'stopped'; sessionRef: string }
  | { type: 'turn.started'; sessionRef: string }
  | { type: 'message.delta'; sessionRef: string; messageId: string; text: string }
  | { type: 'message.completed'; sessionRef: string; messageId: string; role: 'assistant'; text: string }
  | { type: 'tool.call'; sessionRef: string; toolCallId: string; name: string; summary: string; status: 'running' | 'done' | 'failed' }
  | { type: 'request.opened'; sessionRef: string; requestId: string; kind: 'permission' | 'question'; summary: string }
  | { type: 'turn.completed'; sessionRef: string }
  | { type: 'limit.reached'; sessionRef: string; resetsAt?: string }
  | { type: 'error'; sessionRef: string; message: string };

export type UserAction =
  | { type: 'user.message' }
  | { type: 'user.answered' }
  | { type: 'user.stop' }
  | { type: 'user.markDone' }
  | { type: 'user.dragOut' }
  | { type: 'app.restarted' };

export interface Chat {
  id: string;
  provider: ProviderId;
  sessionRef: string | null;
  cwd: string;
  title: string;
  model: string | null;
  column: Column | null;
  needsReason: NeedsReason | null;
  createdAt: string;
  updatedAt: string;
  doneAt: string | null;
  archived: boolean;
  pinned: boolean;
  snoozedUntil: string | null;
}

export interface Message { id: string; chatId: string; role: 'user' | 'assistant'; text: string; createdAt: string }

/** A permission or question the agent is waiting on (read back after a page reload). */
export interface OpenRequest { requestId: string; kind: 'permission' | 'question'; summary: string; createdAt: string }

export interface ToolCall { id: string; chatId: string; name: string; summary: string; status: 'running' | 'done' | 'failed'; createdAt: string }

export interface UsageWindow { kind: 'five_hour' | 'weekly' | 'model'; label: string; leftPct: number; resetsAt: string | null }
export interface UsageReading { provider: ProviderId; status: 'ok' | 'unavailable' | 'signed_out' | 'error'; windows: UsageWindow[]; readAt: string; message?: string }

export interface HistoryChat { provider: ProviderId; sessionRef: string; title: string; cwd: string; updatedAt: string }

export interface ConnectionHealth {
  provider: ProviderId;
  installed: boolean;
  path: string | null;
  version: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  signedIn: boolean | null;
  processOk: boolean;
  status: 'connected' | 'update_available' | 'signed_out' | 'not_installed' | 'degraded';
  message: string | null;
  checkedAt: string;
}

export type ServerEvent =
  | { type: 'chat.updated'; chat: Chat }
  | { type: 'message.delta'; chatId: string; messageId: string; text: string }
  | { type: 'message.completed'; chatId: string; message: Message }
  | { type: 'tool.call'; chatId: string; toolCall: ToolCall }
  | { type: 'request.opened'; chatId: string; requestId: string; kind: 'permission' | 'question'; summary: string }
  | { type: 'usage.updated'; reading: UsageReading }
  | { type: 'connection.updated'; health: ConnectionHealth }
  | { type: 'notification'; chatId: string; kind: 'permission' | 'question' | 'finished' | 'limit' | 'error' };
