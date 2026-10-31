export type ProviderId = 'claude' | 'codex' | 'antigravity';

export type Column = 'running' | 'needs_you' | 'review' | 'done';

export type NeedsReason = 'permission' | 'question' | 'limit' | 'error' | 'interrupted' | 'stopped';

export interface ChatState {
  column: Column;
  needsReason: NeedsReason | null;
}

/**
 * What a permission request is for, so the copy can say "wants to edit a file", "wants to run a command" or
 * "wants to use a tool". Missing (older requests) reads as a command.
 */
export type RequestAction = 'edit' | 'command' | 'tool';

export type AdapterEvent =
  | { type: 'session.started'; sessionRef: string }
  | { type: 'stopped'; sessionRef: string }
  | { type: 'turn.started'; sessionRef: string }
  | { type: 'message.delta'; sessionRef: string; messageId: string; text: string }
  | { type: 'message.completed'; sessionRef: string; messageId: string; role: 'assistant'; text: string }
  | { type: 'tool.call'; sessionRef: string; toolCallId: string; name: string; summary: string; status: 'running' | 'done' | 'failed' }
  | { type: 'request.opened'; sessionRef: string; requestId: string; kind: 'permission' | 'question'; summary: string; action?: RequestAction }
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
export interface OpenRequest { requestId: string; kind: 'permission' | 'question'; summary: string; createdAt: string; action?: RequestAction }

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
  /** `offset` is the stored message length before this delta was appended. */
  | { type: 'message.delta'; chatId: string; messageId: string; text: string; offset: number }
  | { type: 'message.completed'; chatId: string; message: Message }
  | { type: 'tool.call'; chatId: string; toolCall: ToolCall }
  | { type: 'request.opened'; chatId: string; requestId: string; kind: 'permission' | 'question'; summary: string; action?: RequestAction }
  | { type: 'request.closed'; chatId: string; requestId: string }
  | { type: 'usage.updated'; reading: UsageReading }
  | { type: 'connection.updated'; health: ConnectionHealth }
  | { type: 'connect.updated'; state: ConnectState }
  | { type: 'settings.updated'; settings: Settings }
  | { type: 'notification'; chatId: string; kind: 'permission' | 'question' | 'finished' | 'limit' | 'error'; action?: RequestAction };

export type ConnectPhase = 'idle' | 'installing' | 'signing_in' | 'signing_out' | 'updating' | 'error';
export type ConnectOp = 'install' | 'update' | 'signin' | 'signout';
/** How the last operation ended: 'failed' also covers a sign-in that ran out of time (phase 'idle' with its message). */
export type ConnectOutcome = 'done' | 'cancelled' | 'failed';

/** What Agent Kanban is doing for a provider right now (install, sign-in, sign-out, update) and how far it got. */
export interface ConnectState {
  provider: ProviderId;
  phase: ConnectPhase;
  /** Plain step text, e.g. "Downloading Codex…". */
  step: string | null;
  /** 0..1, or null when it can't be measured. */
  progress: number | null;
  /** The sign-in page the provider printed (https only), for "Open the browser again". */
  signInUrl: string | null;
  /** Error or outcome text to show on the card. */
  message: string | null;
  /** The operation that ran last (null until one finishes and while one runs; kept when a health check clears message and outcome). */
  lastOp: ConnectOp | null;
  /** How it ended; null while it runs, and cleared (with message) when a later health check makes a failure moot. */
  outcome: ConnectOutcome | null;
  updatedAt: string;
}

export interface Settings {
  onboarded: boolean;
  /** Show this provider's own chats in Recent chats and Projects. */
  showChats: Record<ProviderId, boolean>;
  /** Consider this provider for the "Most room" suggestion. */
  suggest: Record<ProviderId, boolean>;
  /** Folders the user hid with "Hide project" (projects under the temp folder are hidden without being listed). */
  hiddenProjects: string[];
  /** Folders under the temp folder the user chose to show again (they would otherwise be hidden automatically). */
  unhiddenProjects: string[];
  /** The provider whose skills and global instructions are copied to the others (null until picked). */
  homeProvider?: ProviderId | null;
  /** Skill sync on or off; on by default once a home provider is picked. */
  skillSync?: boolean;
  /** Folder keys of projects with project notes turned on. */
  notesProjects?: string[];
}

/** What skill sync did: names copied to at least one provider, and copies left out because the name was taken. */
export interface SkillsReport {
  synced: string[];
  skipped: { name: string; provider: ProviderId }[];
}

export interface Project {
  /** The absolute folder, exactly as the chats store it. */
  id: string;
  name: string;
  path: string;
  providers: { provider: ProviderId; chats: number; lastUsedAt: string; lastModel: string | null }[];
  columns: Record<Column, number>;
  historyOnly: number;
  lastActivityAt: string;
  /** Kept out of the sidebar, board and New chat: 'auto' for a folder under the temp folder, 'manual' when the user hid it. */
  hidden: 'auto' | 'manual' | null;
  /** The folder is under the temp folder, so it is hidden automatically unless the user unhid it. */
  tempFolder?: boolean;
  /** The folder was moved or deleted: its chats can be read, but no new chat can start there. */
  folderMissing: boolean;
}

export interface ProjectInfo {
  stack: string[];
  git: { branch: string; lastCommit: string; lastCommitAt: string } | null;
  instructionFiles: Record<ProviderId, boolean>;
  topFolders: string[];
}

export interface ModelOption { id: string; label: string; isDefault: boolean }

export { suggest } from './usage.ts';
export { folderKey, claudeScratchRoot, isClaudeScratch, projectFolder, CLAUDE_SCRATCH_NAME } from './paths.ts';
export type { ServerToDesktop, DesktopToServer, DesktopStatus, DesktopBridge } from './desktop.ts';
