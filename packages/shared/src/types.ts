export type ProviderId = 'claude' | 'codex' | 'antigravity';

/** How hard the agent thinks on a turn; each adapter maps it to its provider's own setting. */
export type Effort = 'quick' | 'normal' | 'thorough';
export const EFFORTS: Effort[] = ['quick', 'normal', 'thorough'];

/** What each provider supports. Antigravity has no effort setting yet, so the picker is hidden for it. */
export const PROVIDER_CAPABILITIES: Record<ProviderId, { effort: boolean }> = {
  claude: { effort: true }, codex: { effort: true }, antigravity: { effort: false },
};

export type Column = 'running' | 'needs_you' | 'review' | 'done';

/** `spend-cap`: the chat ran on the user's own API key (#43) and the key reached its monthly spend cap. */
export type NeedsReason = 'permission' | 'question' | 'limit' | 'error' | 'interrupted' | 'stopped' | 'waiting' | 'spend-cap';

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
  | { type: 'error'; sessionRef: string; message: string }
  /**
   * What the provider spent since the last cost event (#43): Claude reports dollars, Codex reports tokens
   * (priced with a small table in apps/server/src/spend.ts). Counts only for chats on the user's own key.
   */
  | { type: 'cost'; sessionRef: string; usd?: number; tokens?: TokenCount };

export interface TokenCount { input: number; cachedInput: number; output: number; model?: string | null }

export type UserAction =
  | { type: 'user.message' }
  | { type: 'user.answered' }
  | { type: 'user.stop' }
  | { type: 'user.markDone' }
  | { type: 'user.dragOut' }
  | { type: 'app.restarted' }
  /** The chat's API key reached its spend cap (#43). */
  | { type: 'spend.capped' };

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
  /** Set while the provider session is in Agent Kanban's 30-day Trash. */
  deletedAt?: string | null;
  pinned: boolean;
  snoozedUntil: string | null;
  /** Out of usage: when it continues on its own (left out when not waiting on a reset, #39). */
  resumeAt?: string | null;
  /** False when the user chose "Don't resume" (left out = resume, the default). */
  autoResume?: boolean;
  /** Messages written while out of usage, sent in order when it can continue (left out when empty). */
  queue?: QueuedMessage[];
  /** Set on a Claude Code chat the user ran outside the app (#37); left out for the app's own chats. */
  origin?: 'outside';
  /** True while that outside chat is still running in Claude Code: it can only be watched, not replied to. */
  outsideLive?: boolean;
  /** The routine that started this chat, if any (#45). */
  routineId?: string | null;
  /** Sticky per chat; applies from the next message. */
  effort: Effort;
  /** Each provider's own session for this chat, kept across handoffs (#40). */
  providerRefs?: Partial<Record<ProviderId, string>>;
  /** "Move to project": the project the chat shows under; it still runs in `cwd`. */
  projectLabel?: string | null;
  /** The user's own API key the chat runs on (#43); left out when it runs on the provider's sign-in. Never the key itself. */
  keyId?: string | null;
}

/** Days are 0 (Sunday) to 6; time is 'HH:MM' in the machine's local time. Daily is all 7 days, Weekdays 1 to 5. */
export interface RoutineSchedule { days: number[]; time: string }
/** How the last run went: started on time, ran late (caught up on open), skipped while the last run was still going, or the folder was missing. */
export type RoutineResult = 'ran' | 'ran_late' | 'skipped_running' | 'folder_missing';
export interface Routine {
  id: string;
  name: string;
  cwd: string;
  provider: ProviderId;
  effort: Effort;
  kind: 'skill' | 'prompt';
  text: string;
  schedule: RoutineSchedule;
  paused: boolean;
  chime: boolean;
  lastRunAt: string | null;
  lastResult: RoutineResult | null;
  lastChatId: string | null;
  /** When the next run is due (null while paused). */
  nextRunAt: string | null;
  createdAt: string;
}

export interface QueuedMessage { id: string; text: string }

/** Providers that can have several accounts (#39); Antigravity has one in v1. */
export type AccountProvider = 'claude' | 'codex';
/** One sign-in to a provider; "default" is the one the provider's own folder holds. */
export interface Account { id: string; provider: AccountProvider; name: string; active: boolean }

/** Providers that can run a chat on the user's own API key (#43). Antigravity signs in with Google only. */
export type KeyProvider = 'claude' | 'codex';
export const KEY_PROVIDERS: KeyProvider[] = ['claude', 'codex'];
/** The environment variable each provider reads its API key from (set in that provider's spawn only). */
export const KEY_ENV: Record<KeyProvider, string> = { claude: 'ANTHROPIC_API_KEY', codex: 'OPENAI_API_KEY' };

/**
 * One of the user's own API keys (#43): metadata only. The key itself lives encrypted in the desktop app's
 * main process and is never sent to the page, broadcast or stored with a chat.
 */
export interface ApiKey {
  id: string;
  provider: KeyProvider;
  name: string;
  /** The key's last 4 characters, shown as ••••1a2b. */
  last4: string;
  /** Monthly spend cap in US dollars; null for no cap. */
  capUsd: number | null;
  /** Spent in `month` (US dollars, as the provider reports or we estimate it). */
  spentUsd: number;
  /** The month `spentUsd` is for, 'YYYY-MM' in local time; a new month starts again at 0. */
  month: string;
}

export interface Message {
  id: string; chatId: string; role: 'user' | 'assistant'; text: string; createdAt: string;
  /** The effort the reply ran at, when it wasn't Normal. */
  effort?: Effort;
  /** Suggested next steps parsed from the reply's trailing `Next:` lines (last assistant message of a turn). */
  suggestions?: string[];
  /** Who wrote it (each reply shows its provider after a handoff). */
  provider?: ProviderId;
}

/** A permission or question the agent is waiting on (read back after a page reload). */
export interface OpenRequest { requestId: string; kind: 'permission' | 'question'; summary: string; createdAt: string; action?: RequestAction }

export interface ToolCall { id: string; chatId: string; name: string; summary: string; status: 'running' | 'done' | 'failed'; createdAt: string }

export interface UsageWindow { kind: 'five_hour' | 'weekly' | 'model'; label: string; leftPct: number; resetsAt: string | null }
export interface UsageReading { provider: ProviderId; status: 'ok' | 'unavailable' | 'signed_out' | 'error'; windows: UsageWindow[]; readAt: string; message?: string }

export interface HistoryChat {
  provider: ProviderId;
  sessionRef: string;
  title: string;
  cwd: string;
  updatedAt: string;
  /** App-side label; provider history files are left untouched when a history-only chat is archived. */
  archived?: boolean;
}

export interface TrashEntry {
  id: string;
  chatId: string | null;
  provider: ProviderId;
  sessionRef: string;
  title: string;
  deletedAt: string;
  daysLeft: number;
}

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
  | { type: 'routines.updated'; routines: Routine[] }
  | { type: 'accounts.updated'; provider: AccountProvider; accounts: Account[] }
  | { type: 'keys.updated'; keys: ApiKey[] }
  | { type: 'hooks.updated'; installed: boolean }
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
  /** Ask agents for up to 3 suggested next steps after each reply (shown as chips). */
  suggestNextSteps: boolean;
  /** The projects the user works on, shown in the sidebar (folder paths); null until the user has picked. */
  myProjects: string[] | null;
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
  /** Every home provider skill, for the composer's `/` list (sent by GET /api/skills). */
  available?: string[];
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
export type { ServerToDesktop, DesktopToServer, DesktopStatus, DesktopBridge, KeyRequest, KeyReply } from './desktop.ts';
