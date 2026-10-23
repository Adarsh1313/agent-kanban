import type {
  Chat,
  ConnectionHealth,
  HistoryChat,
  Message,
  ModelOption,
  OpenRequest,
  Project,
  ProjectInfo,
  ProviderId,
  ToolCall,
  UsageReading,
} from '@agent-kanban/shared';

const TOKEN_KEY = 'agent-kanban.token';

/** Reads the token from `?token=` (then stores it and strips it from the address bar), else from sessionStorage. */
export function readToken(): string | null {
  try {
    const url = new URL(location.href);
    const fromUrl = url.searchParams.get('token');
    if (fromUrl) {
      sessionStorage.setItem(TOKEN_KEY, fromUrl);
      url.searchParams.delete('token');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
      return fromUrl;
    }
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

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

export const api = {
  listChats: () => get<Chat[]>('/api/chats'),
  listMessages: (id: string) => get<Message[]>(`/api/chats/${enc(id)}/messages`),
  listRequests: (id: string) => get<OpenRequest[]>(`/api/chats/${enc(id)}/requests`),
  listToolCalls: (id: string) => get<ToolCall[]>(`/api/chats/${enc(id)}/tool-calls`),
  startChat: (body: { provider: ProviderId; cwd: string; prompt: string; model?: string }) => post<Chat>('/api/chats', body),
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
  projects: () => get<Project[]>('/api/projects'),
  projectInfo: (path: string) => get<ProjectInfo>(`/api/projects/info?path=${enc(path)}`),
  models: () => get<ModelOption[]>('/api/models'),
};
