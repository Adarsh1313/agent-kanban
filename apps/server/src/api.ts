import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { HistoryChat, ProviderId, ServerEvent } from '@agent-kanban/shared';
import { ActiveElsewhereError } from './chats.ts';
import type { ChatService } from './chats.ts';
import type { UsageService } from './usage/service.ts';
import { suggest } from './usage/parse.ts';

const PROVIDERS: ProviderId[] = ['claude', 'codex', 'antigravity'];
const MAX_BODY = 1_000_000;
const PING_MS = 30_000;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function tokenOk(given: string | null | undefined, token: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function allowedOrigin(origin: string | undefined): string | null {
  return origin && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin) ? origin : null;
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'That request is too large.');
    chunks.push(c as Buffer);
  }
  if (size === 0) return {};
  let v: unknown;
  try { v = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'The request body is not valid JSON.'); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'The request body must be a JSON object.');
  return v as Record<string, unknown>;
}

function str(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== 'string' || v.trim() === '') throw new HttpError(400, `Missing "${key}".`);
  return v;
}

function provider(body: Record<string, unknown>): ProviderId {
  const v = body.provider;
  if (typeof v !== 'string' || !PROVIDERS.includes(v as ProviderId)) throw new HttpError(400, 'Unknown provider. Use claude, codex or antigravity.');
  return v as ProviderId;
}

export function createApi(opts: {
  chats: ChatService;
  usage: UsageService;
  history: () => Promise<HistoryChat[]>;
  token: string;
}): { server: http.Server; broadcast: (e: ServerEvent) => void; close: () => void } {
  const { chats, usage, history, token } = opts;
  const wss = new WebSocketServer({ noServer: true });
  const alive = new WeakSet<WebSocket>();

  const broadcast = (e: ServerEvent): void => {
    const data = JSON.stringify(e);
    for (const c of wss.clients) {
      if (c.readyState !== WebSocket.OPEN) continue;
      try { c.send(data, (err) => { if (err) c.terminate(); }); } catch { c.terminate(); }
    }
  };

  const ping = setInterval(() => {
    for (const c of wss.clients) {
      if (!alive.has(c)) { c.terminate(); continue; }
      alive.delete(c);
      try { c.ping(); } catch { c.terminate(); }
    }
  }, PING_MS);
  ping.unref();

  const usageBody = (readings: ReturnType<UsageService['latest']>) => ({ readings, suggested: suggest(readings, PROVIDERS) });

  async function route(req: http.IncomingMessage, url: URL): Promise<{ status: number; body?: unknown }> {
    const method = req.method ?? 'GET';
    const match = (m: string, pattern: string): string[] | null => {
      if (method !== m) return null;
      const re = new RegExp('^' + pattern.replace(/:[a-zA-Z]+/g, '([^/]+)') + '$');
      const r = re.exec(url.pathname);
      return r ? r.slice(1).map(decodeURIComponent) : null;
    };
    let m: string[] | null;
    if (match('GET', '/api/chats')) return { status: 200, body: chats.listChats() };
    if ((m = match('GET', '/api/chats/:id/messages'))) return { status: 200, body: chats.listMessages(m[0]!) };
    if (match('POST', '/api/chats')) {
      const b = await readJson(req);
      const input: { provider: ProviderId; cwd: string; prompt: string; model?: string } = {
        provider: provider(b), cwd: str(b, 'cwd'), prompt: str(b, 'prompt'),
      };
      if (typeof b.model === 'string' && b.model) input.model = b.model;
      return { status: 201, body: await chats.start(input) };
    }
    if ((m = match('POST', '/api/chats/:id/messages'))) {
      const b = await readJson(req);
      await chats.send(m[0]!, str(b, 'text'));
      return { status: 204 };
    }
    if ((m = match('POST', '/api/chats/:id/requests/:requestId'))) {
      const b = await readJson(req);
      const d = b.decision;
      let decision: 'allow' | 'deny' | { reply: string };
      if (d === 'allow' || d === 'deny') decision = d;
      else if (d && typeof d === 'object' && typeof (d as { reply?: unknown }).reply === 'string') decision = { reply: (d as { reply: string }).reply };
      else throw new HttpError(400, 'Decision must be "allow", "deny" or { "reply": text }.');
      await chats.answer(m[0]!, m[1]!, decision);
      return { status: 204 };
    }
    if ((m = match('POST', '/api/chats/:id/stop'))) { await chats.stop(m[0]!); return { status: 200, body: chats.getChat(m[0]!) }; }
    if ((m = match('POST', '/api/chats/:id/done'))) return { status: 200, body: chats.markDone(m[0]!) };
    if ((m = match('POST', '/api/chats/:id/undone'))) return { status: 200, body: chats.dragOutOfDone(m[0]!) };
    if ((m = match('POST', '/api/chats/:id/archive'))) return { status: 200, body: chats.archive(m[0]!) };
    if (match('GET', '/api/history')) return { status: 200, body: await history() };
    if (match('POST', '/api/history/continue')) {
      const b = await readJson(req);
      const p = provider(b); const ref = str(b, 'sessionRef'); const text = str(b, 'text');
      const h = (await history()).find((x) => x.provider === p && x.sessionRef === ref);
      if (!h) throw new HttpError(404, 'Chat not found.');
      return { status: 200, body: await chats.continueHistory(h, text) };
    }
    if (match('GET', '/api/usage')) return { status: 200, body: usageBody(usage.latest()) };
    if (match('POST', '/api/usage/refresh')) {
      await usage.refresh();
      return { status: 200, body: usageBody(usage.latest()) };
    }
    throw new HttpError(404, 'Not found.');
  }

  const server = http.createServer((req, res) => {
    const origin = allowedOrigin(req.headers.origin);
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    const send = (status: number, body?: unknown) => {
      if (body === undefined) { res.writeHead(status); res.end(); return; }
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') return send(204);
    const auth = req.headers.authorization;
    const given = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!tokenOk(given, token)) return send(401, { error: 'Missing or wrong token.' });
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    route(req, url).then(
      (r) => send(r.status, r.body),
      (err: unknown) => {
        if (err instanceof HttpError) return send(err.status, { error: err.message });
        const msg = err instanceof Error ? err.message : '';
        if (err instanceof ActiveElsewhereError) return send(409, { error: msg });
        if (msg === 'That request is no longer open.') return send(409, { error: msg });
        if (msg === 'Chat not found.') return send(404, { error: msg });
        console.error(err);
        send(500, { error: 'Something went wrong.' });
      },
    );
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/ws' || !tokenOk(url.searchParams.get('token'), token)) {
      const code = url.pathname === '/ws' ? '401 Unauthorized' : '404 Not Found';
      socket.write(`HTTP/1.1 ${code}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      alive.add(ws);
      ws.on('pong', () => alive.add(ws));
      ws.on('error', () => ws.terminate());
      ws.on('message', () => {});
    });
  });

  const close = (): void => {
    clearInterval(ping);
    for (const c of wss.clients) c.terminate();
    wss.close();
  };
  server.on('close', () => clearInterval(ping));

  return { server, broadcast, close };
}
