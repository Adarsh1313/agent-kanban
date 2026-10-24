// Agent Client Protocol (ACP) client: JSON-RPC 2.0 over stdio, used to drive Google's official agy_acp_server.
// The JsonRpcProcess passed in must be created with `{ jsonrpc: '2.0' }`.
import type { JsonRpcProcess } from './jsonrpc.ts';

export const AUTH_LINE_PREFIX = 'Open the following link to authenticate the ACP server: ';

export type AcpInitializeResult = {
  protocolVersion: number;
  agentInfo?: { name: string; version: string };
  authMethods: { id: string; name: string }[];
  authenticated: boolean;
};

export type AcpPermissionOption = { optionId: string; name: string; kind: string };
export type AcpPermissionRequest = { toolCall: any; options: AcpPermissionOption[] };
export type AcpPermissionDecision = { optionId: string } | 'cancelled';
export type AcpStopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled' | 'unknown';

const STOP_REASONS: ReadonlySet<string> = new Set(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled']);
const CANCELLED = { outcome: { outcome: 'cancelled' } } as const;

const INIT_PARAMS = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
};

// A turn can run for a long time; the adapter cancels or closes the process when it gives up.
const PROMPT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

const REDIRECT_RE = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/$/;
// Google's OAuth endpoints. Task 3 confirms which one agy_acp_server prints.
const AUTH_PATHS: ReadonlySet<string> = new Set(['/o/oauth2/v2/auth', '/o/oauth2/auth']);
// Printable ASCII, then a narrower allowlist: no quotes, ^, |, <, >, backslash, backtick, braces, spaces or controls.
const PRINTABLE_ASCII_RE = /^[!-~]+$/;
const URL_CHARS_RE = /^[A-Za-z0-9\-._~:\/?&=%+,]+$/;

/**
 * Returns the sign-in URL (normalised) if it is exactly what Antigravity's sign-in prints:
 * https://accounts.google.com/o/oauth2/(v2/)auth?... with one `redirect_uri` of http://127.0.0.1:<port>/.
 * Anything else returns null.
 */
export function parseAuthUrl(raw: string): string | null {
  const text = raw.trim();
  if (!PRINTABLE_ASCII_RE.test(text) || !URL_CHARS_RE.test(text)) return null;
  if (!text.startsWith('https://accounts.google.com/')) return null;
  if (/%(?![0-9A-Fa-f]{2})/.test(text)) return null; // every % must be a percent-escape
  let url: URL;
  try { url = new URL(text); } catch { return null; }
  if (url.origin !== 'https://accounts.google.com' || url.username || url.password) return null;
  if (!AUTH_PATHS.has(url.pathname)) return null;
  // every query part must be key=value (no bare `&calc`-style parts)
  if (!url.search || url.search.slice(1).split('&').some((part) => !/^[^=]+=/.test(part))) return null;
  const redirects = url.searchParams.getAll('redirect_uri');
  if (redirects.length !== 1) return null;
  const m = REDIRECT_RE.exec(redirects[0]);
  if (!m) return null;
  const port = Number(m[1]);
  if (port < 1 || port > 65535) return null;
  return url.href;
}

function readAuthenticated(result: any, authMethods: unknown[]): boolean {
  // Prefer an explicit flag from the agent; otherwise an agent that offers no auth methods needs no sign-in.
  if (typeof result?.authenticated === 'boolean') return result.authenticated;
  if (typeof result?._meta?.authenticated === 'boolean') return result._meta.authenticated;
  return authMethods.length === 0;
}

export class AcpClient {
  private proc: JsonRpcProcess;
  private updateFns: Array<(sessionId: string, update: any) => void> = [];
  private permissionFn: ((sessionId: string, req: AcpPermissionRequest) => Promise<AcpPermissionDecision>) | null = null;
  private authUrlFns: Array<(url: string) => void> = [];
  // Open session/request_permission requests per session; cancel() answers them with 'cancelled'.
  private openPermissions = new Map<string, Set<() => void>>();

  constructor(proc: JsonRpcProcess) {
    this.proc = proc;
    proc.onNotification((method, params) => {
      if (method !== 'session/update' || typeof params?.sessionId !== 'string') return;
      for (const fn of this.updateFns) fn(params.sessionId, params.update);
    });
    proc.onRequest(async (method, params) => {
      if (method !== 'session/request_permission') throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
      return this.answerPermission(String(params?.sessionId ?? ''), params);
    });
    proc.onTextLine((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith(AUTH_LINE_PREFIX)) return;
      const url = parseAuthUrl(trimmed.slice(AUTH_LINE_PREFIX.length));
      if (url) for (const fn of this.authUrlFns) fn(url);
    });
  }

  private async answerPermission(sessionId: string, params: any): Promise<unknown> {
    const req: AcpPermissionRequest = { toolCall: params?.toolCall, options: Array.isArray(params?.options) ? params.options : [] };
    let release!: () => void;
    const cancelled = new Promise<'cancelled'>((resolve) => { release = () => resolve('cancelled'); });
    let open = this.openPermissions.get(sessionId);
    if (!open) { open = new Set(); this.openPermissions.set(sessionId, open); }
    open.add(release);
    try {
      const asked: Promise<unknown> = this.permissionFn
        ? Promise.resolve().then(() => this.permissionFn!(sessionId, req)).catch(() => 'cancelled')
        : Promise.resolve('cancelled');
      const decision: any = await Promise.race([asked, cancelled]);
      const optionId = decision && typeof decision === 'object' ? decision.optionId : undefined;
      if (typeof optionId !== 'string' || !req.options.some((o) => o.optionId === optionId)) return CANCELLED;
      return { outcome: { outcome: 'selected', optionId } };
    } finally {
      open.delete(release);
      if (open.size === 0 && this.openPermissions.get(sessionId) === open) this.openPermissions.delete(sessionId);
    }
  }

  async initialize(): Promise<AcpInitializeResult> {
    const r = await this.proc.request<any>('initialize', INIT_PARAMS);
    const authMethods = (Array.isArray(r?.authMethods) ? r.authMethods : [])
      .filter((m: any) => typeof m?.id === 'string')
      .map((m: any) => ({ id: m.id, name: typeof m.name === 'string' ? m.name : m.id }));
    const info = r?.agentInfo;
    const agentInfo = info && typeof info.name === 'string' ? { name: info.name, version: String(info.version ?? '') } : undefined;
    return {
      protocolVersion: typeof r?.protocolVersion === 'number' ? r.protocolVersion : 1,
      ...(agentInfo ? { agentInfo } : {}),
      authMethods,
      authenticated: readAuthenticated(r, authMethods),
    };
  }

  /** Runs the agent's sign-in. It can take as long as the user takes in the browser; the caller enforces its own limit. */
  async authenticate(methodId: string): Promise<void> {
    await this.proc.request('authenticate', { methodId }, PROMPT_TIMEOUT_MS);
  }

  async newSession(cwd: string): Promise<string> {
    const r = await this.proc.request<any>('session/new', { cwd, mcpServers: [] });
    if (typeof r?.sessionId !== 'string') throw new Error('session/new returned no sessionId');
    return r.sessionId;
  }

  async loadSession(sessionId: string, cwd: string): Promise<void> {
    await this.proc.request('session/load', { sessionId, cwd, mcpServers: [] });
  }

  async prompt(sessionId: string, text: string): Promise<{ stopReason: AcpStopReason }> {
    const r = await this.proc.request<any>('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, PROMPT_TIMEOUT_MS);
    const reason = r?.stopReason;
    return { stopReason: typeof reason === 'string' && STOP_REASONS.has(reason) ? reason as AcpStopReason : 'unknown' };
  }

  /** Sends session/cancel and answers every open permission request for the session with 'cancelled'. */
  cancel(sessionId: string): void {
    this.proc.notify('session/cancel', { sessionId });
    const open = this.openPermissions.get(sessionId);
    if (open) for (const release of [...open]) release();
  }

  onUpdate(fn: (sessionId: string, update: any) => void): void { this.updateFns.push(fn); }
  onPermission(fn: (sessionId: string, req: AcpPermissionRequest) => Promise<AcpPermissionDecision>): void { this.permissionFn = fn; }
  onAuthUrl(fn: (url: string) => void): void { this.authUrlFns.push(fn); }
}
