import type {
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
  Settings,
  ToolCall,
  UsageReading,
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
export interface ChatPatch { title?: string; pinned?: boolean; snoozedUntil?: string | null }
export interface UsageResponse { readings: UsageReading[]; suggested: ProviderId | null }
/** What the Connections page can ask the server to do for a provider (`open` re-opens the sign-in page the server holds). */
export type ConnectAction = 'install' | 'signin' | 'signout' | 'update' | 'cancel' | 'open';
export interface SettingsPatch {
  onboarded?: boolean;
  showChats?: Partial<Record<ProviderId, boolean>>;
  suggest?: Partial<Record<ProviderId, boolean>>;
}

export const api = {
  listChats: () => get<Chat[]>('/api/chats'),
  listMessages: (id: string) => get<Message[]>(`/api/chats/${enc(id)}/messages`),
  listRequests: (id: string) => get<OpenRequest[]>(`/api/chats/${enc(id)}/requests`),
  listToolCalls: (id: string) => get<ToolCall[]>(`/api/chats/${enc(id)}/tool-calls`),
  startChat: (body: { provider: ProviderId; cwd: string; prompt: string; model?: string }) => post<Chat>('/api/chats', body),
  /** Shows the computer's own folder picker; null when it was cancelled (#24). */
  pickFolder: () => post<{ path: string | null }>('/api/folders/pick'),
  send: (id: string, text: string) => post<void>(`/api/chats/${enc(id)}/messages`, { text }),
  answer: (id: string, requestId: string, decision: AnswerDecision) =>
    post<void>(`/api/chats/${enc(id)}/requests/${enc(requestId)}`, { decision }),
  stop: (id: string) => post<Chat>(`/api/chats/${enc(id)}/stop`),
  done: (id: string) => post<Chat>(`/api/chats/${enc(id)}/done`),
  undone: (id: string) => post<Chat>(`/api/chats/${enc(id)}/undone`),
  archive: (id: string, opts: RequestOptions = {}) => request<Chat>('POST', `/api/chats/${enc(id)}/archive`, undefined, opts),
  patchChat: (id: string, patch: ChatPatch) => request<Chat>('PATCH', `/api/chats/${enc(id)}`, patch),
  history: () => get<HistoryChat[]>('/api/history'),
  continueHistory: (body: { provider: ProviderId; sessionRef: string; text: string }) => post<Chat>('/api/history/continue', body),
  usage: () => get<UsageResponse>('/api/usage'),
  refreshUsage: () => post<UsageResponse>('/api/usage/refresh'),
  connections: () => get<ConnectionHealth[]>('/api/connections'),
  checkConnections: (provider?: ProviderId) => post<ConnectionHealth[]>('/api/connections/check', provider ? { provider } : {}),
  connectStates: () => get<ConnectState[]>('/api/connect'),
  /** Starts (or cancels) an operation; the answer is the provider's state right after, and progress follows as connect.updated events. */
  connect: (provider: ProviderId, action: ConnectAction) => post<ConnectState>(`/api/connect/${enc(provider)}/${action}`),
  settings: () => get<Settings>('/api/settings'),
  patchSettings: (patch: SettingsPatch) => request<Settings>('PATCH', '/api/settings', patch),
  projects: () => get<Project[]>('/api/projects'),
  projectInfo: (path: string) => get<ProjectInfo>(`/api/projects/info?path=${enc(path)}`),
  /** Every provider's models (an empty list when a provider's CLI could not be asked). */
  models: () => get<Record<ProviderId, ModelOption[]>>('/api/models'),
};
