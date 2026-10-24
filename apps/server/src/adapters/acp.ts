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

const INIT_PARAMS = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
};

// A turn can run for a long time; the adapter cancels or closes the process when it gives up.
const PROMPT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

const REDIRECT_RE = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/$/;

/**
 * Returns the sign-in URL if it is exactly what Antigravity's sign-in prints: https://accounts.google.com/...
 * with one `redirect_uri` of http://127.0.0.1:<port>/. Anything else returns null.
 */
export function parseAuthUrl(raw: string): string | null {
  const text = raw.trim();
  if (!text.startsWith('https://accounts.google.com/') || /\s/.test(text)) return null;
  let url: URL;
  try { url = new URL(text); } catch { return null; }
  if (url.origin !== 'https://accounts.google.com' || url.username || url.password) return null;
  const redirects = url.searchParams.getAll('redirect_uri');
  if (redirects.length !== 1) return null;
  const m = REDIRECT_RE.exec(redirects[0]);
  if (!m) return null;
  const port = Number(m[1]);
  if (port < 1 || port > 65535) return null;
  return text;
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

  constructor(proc: JsonRpcProcess) {
    this.proc = proc;
    proc.onNotification((method, params) => {
      if (method !== 'session/update' || typeof params?.sessionId !== 'string') return;
      for (const fn of this.updateFns) fn(params.sessionId, params.update);
    });
    proc.onRequest(async (method, params) => {
      if (method !== 'session/request_permission') throw new Error(`unsupported: ${method}`);
      const req: AcpPermissionRequest = { toolCall: params?.toolCall, options: Array.isArray(params?.options) ? params.options : [] };
      const decision = this.permissionFn ? await this.permissionFn(String(params?.sessionId ?? ''), req) : 'cancelled';
      if (decision === 'cancelled' || !req.options.some((o) => o.optionId === decision.optionId)) {
        return { outcome: { outcome: 'cancelled' } };
      }
      return { outcome: { outcome: 'selected', optionId: decision.optionId } };
    });
    proc.onTextLine((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith(AUTH_LINE_PREFIX)) return;
      const url = parseAuthUrl(trimmed.slice(AUTH_LINE_PREFIX.length));
      if (url) for (const fn of this.authUrlFns) fn(url);
    });
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

  async prompt(sessionId: string, text: string): Promise<{ stopReason: string }> {
    const r = await this.proc.request<any>('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, PROMPT_TIMEOUT_MS);
    return { stopReason: typeof r?.stopReason === 'string' ? r.stopReason : 'end_turn' };
  }

  cancel(sessionId: string): void {
    this.proc.notify('session/cancel', { sessionId });
  }

  onUpdate(fn: (sessionId: string, update: any) => void): void { this.updateFns.push(fn); }
  onPermission(fn: (sessionId: string, req: AcpPermissionRequest) => Promise<AcpPermissionDecision>): void { this.permissionFn = fn; }
  onAuthUrl(fn: (url: string) => void): void { this.authUrlFns.push(fn); }
}
