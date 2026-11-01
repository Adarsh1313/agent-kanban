import type {
  Effort,
  Chat,
  ConnectionHealth,
  ConnectState,
  HistoryChat,
  Message,
  ModelOption,
  OpenRequest,
  Project,
  ProjectInfo,
  ProviderId,
  Routine,
  Settings,
  SkillsReport,
  ToolCall,
  TrashEntry,
  UsageReading, Account, AccountProvider,
} from '@agent-kanban/shared';

const TOKEN_KEY = 'agent-kanban.token';

/** The token once known, so every request does not reread storage (and a blocked sessionStorage still works). */
let cachedToken: string | null = null;

/**
 * Reads the token from `?token=` (stripping it from the address bar first, whatever storage does), else from
 * sessionStorage. The result is kept in memory.
 */
export function readToken(): string | null {
  let fromUrl: string | null = null;
  try {
    const url = new URL(location.href);
    fromUrl = url.searchParams.get('token');
    if (fromUrl) {
      url.searchParams.delete('token');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
  } catch {
    // no usable location/history: fall through to storage
  }
  if (fromUrl) {
    cachedToken = fromUrl;
    try { sessionStorage.setItem(TOKEN_KEY, fromUrl); } catch { /* storage blocked: the in-memory copy is enough for this page */ }
    return fromUrl;
  }
  if (cachedToken) return cachedToken;
  try {
    cachedToken = sessionStorage.getItem(TOKEN_KEY);
  } catch {
    cachedToken = null;
  }
  return cachedToken;
}

/** Tests start without a remembered token. */
export const resetTokenCache = () => { cachedToken = null; };

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

interface RequestOptions {
  /** Lets the request outlive the page (used when the page is closing). */
  keepalive?: boolean;
}

async function request<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const headers = new Headers();
  const token = readToken();
  if (token) headers.set('authorization', `Bearer ${token}`);
  let payload: string | undefined;
  if (body !== undefined) {
    headers.set('content-type', 'application/json');
    payload = JSON.stringify(body);
  }
  const res = await fetch(path, { method, headers, body: payload, ...(opts.keepalive ? { keepalive: true } : {}) });
  if (!res.ok) {
    let message = `Request failed (${res.status}).`;
    try {
      const data = (await res.json()) as { error?: unknown };
      if (typeof data.error === 'string' && data.error) message = data.error;
    } catch {
      // not JSON: keep the generic message
    }
    throw new ApiError(message, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const enc = encodeURIComponent;
const get = <T>(path: string) => request<T>('GET', path);
const post = <T>(path: string, body?: unknown) => request<T>('POST', path, body);

export type AnswerDecision = 'allow' | 'deny' | { reply: string };
export interface ChatPatch { title?: string; pinned?: boolean; snoozedUntil?: string | null; effort?: Effort; autoResume?: boolean; projectLabel?: string | null }
export interface UsageResponse { readings: UsageReading[]; suggested: ProviderId | null }
/** What the Connections page can ask the server to do for a provider (`open` re-opens the sign-in page the server holds). */
export type ConnectAction = 'install' | 'signin' | 'signout' | 'update' | 'cancel' | 'open';
export interface SettingsPatch {
  onboarded?: boolean;
  showChats?: Partial<Record<ProviderId, boolean>>;
  suggest?: Partial<Record<ProviderId, boolean>>;
  hiddenProjects?: string[];
  unhiddenProjects?: string[];
  homeProvider?: ProviderId | null;
  skillSync?: boolean;
  notesProjects?: string[];
  suggestNextSteps?: boolean;
  myProjects?: string[] | null;
}

/** What the routine editor sends: every field on create, any of them on change (#45). */
export type RoutineBody = Partial<Pick<Routine, 'name' | 'cwd' | 'provider' | 'effort' | 'kind' | 'text' | 'schedule' | 'chime' | 'paused'>>;

export interface Transcript {
  messages: { role: 'user' | 'assistant'; text: string; at: string | null }[];
  truncated: boolean;
  unavailable: boolean;
}

export const api = {
  listChats: () => get<Chat[]>('/api/chats?archived=all'),
  listMessages: (id: string) => get<Message[]>(`/api/chats/${enc(id)}/messages`),
  listRequests: (id: string) => get<OpenRequest[]>(`/api/chats/${enc(id)}/requests`),
  listToolCalls: (id: string) => get<ToolCall[]>(`/api/chats/${enc(id)}/tool-calls`),
  startChat: (body: { provider: ProviderId; cwd: string; prompt: string; model?: string }) => post<Chat>('/api/chats', body),
  /** Shows the computer's own folder picker; null when it was cancelled (#24). */
  pickFolder: () => post<{ path: string | null }>('/api/folders/pick'),
  /** Shows a project folder in the computer's file manager (#15). */
  openFolder: (path: string) => post<void>('/api/folders/open', { path }),
  /** `provider` other than the chat's hands the chat over to it with this message (#40). */
  send: (id: string, text: string, provider?: ProviderId) => post<void>(`/api/chats/${enc(id)}/messages`, provider ? { text, provider } : { text }),
  answer: (id: string, requestId: string, decision: AnswerDecision) =>
    post<void>(`/api/chats/${enc(id)}/requests/${enc(requestId)}`, { decision }),
  stop: (id: string) => post<Chat>(`/api/chats/${enc(id)}/stop`),
  done: (id: string) => post<Chat>(`/api/chats/${enc(id)}/done`),
  undone: (id: string) => post<Chat>(`/api/chats/${enc(id)}/undone`),
  archive: (id: string, opts: RequestOptions = {}) => request<Chat>('POST', `/api/chats/${enc(id)}/archive`, undefined, opts),
  unarchive: (id: string) => post<Chat>(`/api/chats/${enc(id)}/unarchive`),
  deleteChat: (id: string) => post<TrashEntry>(`/api/chats/${enc(id)}/delete`),
  /** The follow-up queue of an out-of-usage chat (#39). */
  editQueued: (id: string, queued: string, text: string) => request<Chat>('PATCH', `/api/chats/${enc(id)}/queue/${enc(queued)}`, { text }),
  removeQueued: (id: string, queued: string) => request<Chat>('DELETE', `/api/chats/${enc(id)}/queue/${enc(queued)}`),
  sendQueuedNow: (id: string, queued: string) => post<void>(`/api/chats/${enc(id)}/queue/${enc(queued)}/send-now`),
  patchChat: (id: string, patch: ChatPatch) => request<Chat>('PATCH', `/api/chats/${enc(id)}`, patch),
  history: () => get<HistoryChat[]>('/api/history?archived=all'),
  archiveHistory: (provider: ProviderId, sessionRef: string) => post<HistoryChat>(`/api/history/${provider}/${enc(sessionRef)}/archive`),
  unarchiveHistory: (provider: ProviderId, sessionRef: string) => post<HistoryChat>(`/api/history/${provider}/${enc(sessionRef)}/unarchive`),
  deleteHistory: (provider: ProviderId, sessionRef: string) => post<TrashEntry>(`/api/history/${provider}/${enc(sessionRef)}/delete`),
  trash: () => get<TrashEntry[]>('/api/trash'),
  restoreTrash: (id: string) => post<TrashEntry>(`/api/trash/${enc(id)}/restore`),
  emptyTrash: () => request<void>('DELETE', '/api/trash'),
  continueHistory: (body: { provider: ProviderId; sessionRef: string; text: string }) => post<Chat>('/api/history/continue', body),
  /** Past messages of a history-only chat, read-only (#16). */
  historyMessages: (provider: ProviderId, sessionRef: string) =>
    get<Transcript>(`/api/history/${provider}/${encodeURIComponent(sessionRef)}/messages`),
  usage: () => get<UsageResponse>('/api/usage'),
  /** Project notes (#40): turn on or off (answers the new settings), read and save. */
  setNotes: (path: string, on: boolean) => post<Settings>('/api/projects/notes', { path, on }),
  notes: (path: string) => get<{ text: string }>(`/api/projects/notes?path=${enc(path)}`),
  saveNotes: (path: string, text: string) => request<{ text: string }>('PUT', '/api/projects/notes', { path, text }),
  /** Skill sync's last report plus every home provider skill (#40). */
  skills: () => get<SkillsReport>('/api/skills'),
  syncSkills: () => post<SkillsReport>('/api/skills/sync'),
  refreshUsage: () => post<UsageResponse>('/api/usage/refresh'),
  connections: () => get<ConnectionHealth[]>('/api/connections'),
  checkConnections: (provider?: ProviderId) => post<ConnectionHealth[]>('/api/connections/check', provider ? { provider } : {}),
  connectStates: () => get<ConnectState[]>('/api/connect'),
  /** Starts (or cancels) an operation; the answer is the provider's state right after, and progress follows as connect.updated events. */
  connect: (provider: ProviderId, action: ConnectAction) => post<ConnectState>(`/api/connect/${enc(provider)}/${action}`),
  /** Several accounts per provider (#39); each change answers with that provider's accounts. */
  accounts: () => get<Record<AccountProvider, Account[]>>('/api/accounts'),
  addAccount: (provider: AccountProvider, name: string) => post<Account[]>('/api/accounts', { provider, name }),
  renameAccount: (provider: AccountProvider, id: string, name: string) => request<Account[]>('PATCH', `/api/accounts/${provider}/${enc(id)}`, { name }),
  activateAccount: (provider: AccountProvider, id: string) => post<Account[]>(`/api/accounts/${provider}/${enc(id)}/activate`),
  removeAccount: (provider: AccountProvider, id: string) => request<Account[]>('DELETE', `/api/accounts/${provider}/${enc(id)}`),
  /** Codex's banked free resets (#31). */
  codexResets: () => get<{ available: number }>('/api/usage/codex/resets'),
  useCodexReset: () => post<{ outcome: string }>('/api/usage/codex/resets/use'),
  resumeNow: (id: string) => post<void>(`/api/chats/${enc(id)}/resume-now`),
  /** Whether Claude Code tells the app about chats run outside it (#37). */
  claudeHooks: () => get<{ installed: boolean }>('/api/hooks/claude'),
  setClaudeHooks: (on: boolean) => post<{ installed: boolean }>(`/api/hooks/claude/${on ? 'install' : 'remove'}`),
  settings: () => get<Settings>('/api/settings'),
  patchSettings: (patch: SettingsPatch) => request<Settings>('PATCH', '/api/settings', patch),
  projects: () => get<Project[]>('/api/projects'),
  projectInfo: (path: string) => get<ProjectInfo>(`/api/projects/info?path=${enc(path)}`),
  routines: () => get<Routine[]>('/api/routines'),
  createRoutine: (body: RoutineBody) => post<Routine>('/api/routines', body),
  patchRoutine: (id: string, body: RoutineBody) => request<Routine>('PATCH', `/api/routines/${enc(id)}`, body),
  deleteRoutine: (id: string) => request<void>('DELETE', `/api/routines/${enc(id)}`),
  runRoutine: (id: string) => post<Routine>(`/api/routines/${enc(id)}/run`),
  /** Every provider's models (an empty list when a provider's CLI could not be asked). */
  models: () => get<Record<ProviderId, ModelOption[]>>('/api/models'),
};
