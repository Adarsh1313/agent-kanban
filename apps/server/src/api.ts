import http from 'node:http';
import { statusPageHtml } from './status-page.ts';
import { DEFAULT_DIST, readStatic, shellFile, staticFile } from './static.ts';
import { buildProjects, projectInfo } from './projects.ts';
import type { ProviderAdapter } from './adapters/adapter.ts';
import { statSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { ConnectionHealth, HistoryChat, ModelOption, ProviderId, ServerEvent } from '@agent-kanban/shared';
import { ActiveElsewhereError, CantContinueError } from './chats.ts';
import { ConnectBusyError, ConnectStateError } from './connect/service.ts';
import { PickerBusyError } from './folder-picker.ts';
import type { Transcript } from './history/transcript.ts';
import type { ConnectService } from './connect/service.ts';
import { SettingsError } from './settings.ts';
import type { SettingsStore } from './settings.ts';
import type { ChatService } from './chats.ts';
import type { UsageService } from './usage/service.ts';
// suggest() lives in shared so the web app can recompute "Most room" from usage.updated events.
import { folderKey, suggest } from '@agent-kanban/shared';

const PROVIDERS: ProviderId[] = ['claude', 'codex', 'antigravity'];
const MAX_BODY = 1_000_000;
const MAX_DRAIN = 16_000_000; // past this, an oversized upload is cut off rather than read to the end
const DRAIN_MS = 5_000;
const PING_MS = 30_000;
const MODELS_MS = 15_000;
const MODELS_CACHE_MS = 5 * 60_000;
const MAX_BUFFERED = 4_000_000;

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

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > MAX_BODY) { req.resume(); return reject(new HttpError(413, 'That request is too large.')); }
    let chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      if (over) return; // keep draining, buffer nothing
      size += c.length;
      if (size > MAX_BODY) { over = true; chunks = []; reject(new HttpError(413, 'That request is too large.')); return; }
      chunks.push(c);
    });
    req.on('error', reject);
    req.on('end', () => {
      if (over) return;
      if (size === 0) return resolve({});
      let v: unknown;
      try { v = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reject(new HttpError(400, 'The request body is not valid JSON.')); }
      if (!v || typeof v !== 'object' || Array.isArray(v)) return reject(new HttpError(400, 'The request body must be a JSON object.'));
      resolve(v as Record<string, unknown>);
    });
  });
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


function existingFolder(cwd: string): string {
  let ok = false;
  try { ok = statSync(cwd).isDirectory(); } catch { /* missing or unreadable */ }
  if (!ok) throw new HttpError(400, "That folder doesn't exist.");
  return cwd;
}

export function createApi(opts: {
  chats: ChatService;
  usage: UsageService;
  history: () => Promise<HistoryChat[]>;
  connections?: { latest: () => ConnectionHealth[]; check: (provider?: ProviderId) => Promise<ConnectionHealth[]> };
  adapters?: { get(id: ProviderId): ProviderAdapter | undefined };
  connect?: Pick<ConnectService, 'states' | 'install' | 'signIn' | 'signOut' | 'update' | 'cancel' | 'openSignInPage'>;
  settings?: SettingsStore;
  /** Past messages of a chat that is only in the provider's history (#16). */
  transcript?: (provider: ProviderId, sessionRef: string) => Promise<Transcript>;
  /** New chat's "Browse…": shows the native folder picker (#24). */
  folderPicker?: { pick(): Promise<string | null> };
  /** Folder holding the built web app (default apps/web/dist). */
  webDist?: string;
  token: string;
  pingMs?: number;
}): { server: http.Server; broadcast: (e: ServerEvent) => void; close: () => void } {
  const { chats, usage, history, token } = opts;
  const pingMs = opts.pingMs ?? PING_MS;
  const dist = opts.webDist ?? DEFAULT_DIST;
  const wss = new WebSocketServer({ noServer: true });
  const alive = new WeakSet<WebSocket>();

  const broadcast = (e: ServerEvent): void => {
    const data = JSON.stringify(e);
    for (const c of wss.clients) {
      if (c.readyState !== WebSocket.OPEN) continue;
      if (c.bufferedAmount > MAX_BUFFERED) { c.terminate(); continue; }
      try { c.send(data, (err) => { if (err) c.terminate(); }); } catch { c.terminate(); }
    }
  };

  const ping = setInterval(() => {
    for (const c of wss.clients) {
      if (!alive.has(c)) { c.terminate(); continue; }
      alive.delete(c);
      try { c.ping(); } catch { c.terminate(); }
    }
  }, pingMs);
  ping.unref();

  const settings = opts.settings;
  // The "Suggest it for new chats" switches limit which providers "Most room" may pick.
  const usageBody = (readings: ReturnType<UsageService['latest']>) => ({ readings, suggested: suggest(readings, settings ? settings.suggestable() : PROVIDERS) });
  // History of providers whose "Show its chats" switch is off is left out of Recent chats and Projects.
  const visibleHistory = async (): Promise<HistoryChat[]> => {
    const all = await history();
    return settings ? settings.filterHistory(all) : all;
  };

  // A provider's model list rarely changes: a non-empty answer is reused for 5 minutes (an empty one is asked again).
  const modelCache = new Map<ProviderId, { at: number; models: ModelOption[] }>();
  async function models(): Promise<Record<ProviderId, ModelOption[]>> {
    const one = async (id: ProviderId): Promise<ModelOption[]> => {
      const a = opts.adapters?.get(id);
      if (!a) return [];
      const hit = modelCache.get(id);
      if (hit && Date.now() - hit.at < MODELS_CACHE_MS) return hit.models;
      let timer: NodeJS.Timeout | undefined;
      try {
        const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), MODELS_MS); });
        const list = await Promise.race([a.listModels(), timeout]);
        if (list.length > 0) modelCache.set(id, { at: Date.now(), models: list });
        return list;
      } catch { return []; } finally { clearTimeout(timer); }
    };
    const [claude, codex, antigravity] = await Promise.all(PROVIDERS.map(one));
    return { claude: claude!, codex: codex!, antigravity: antigravity! };
  }

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
    if ((m = match('GET', '/api/chats/:id/requests'))) return { status: 200, body: chats.listOpenRequests(m[0]!) };
    if ((m = match('GET', '/api/chats/:id/tool-calls'))) return { status: 200, body: chats.listToolCalls(m[0]!) };
    if ((m = match('PATCH', '/api/chats/:id'))) {
      const b = await readJson(req);
      const patch: { title?: string; pinned?: boolean; snoozedUntil?: string | null } = {};
      for (const [k, v] of Object.entries(b)) {
        if (k === 'title') {
          const t = typeof v === 'string' ? v.trim() : '';
          if (t === '' || t.length > 200) throw new HttpError(400, 'Title must be 1 to 200 characters.');
          patch.title = t;
        } else if (k === 'pinned') {
          if (typeof v !== 'boolean') throw new HttpError(400, 'Pinned must be true or false.');
          patch.pinned = v;
        } else if (k === 'snoozedUntil') {
          if (v === null) patch.snoozedUntil = null;
          else {
            if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw new HttpError(400, 'Snooze time must be a date.');
            patch.snoozedUntil = new Date(v).toISOString();
          }
        } else throw new HttpError(400, `You can't change "${k}".`);
      }
      return { status: 200, body: chats.patch(m[0]!, patch) };
    }
    if (match('GET', '/api/projects')) return { status: 200, body: buildProjects(chats.listChats(), await visibleHistory()) };
    if (match('GET', '/api/projects/info')) {
      const path = url.searchParams.get('path');
      const key = path ? folderKey(path) : '';
      const known = key ? buildProjects(chats.listChats(), await visibleHistory()).find((p) => folderKey(p.id) === key) : undefined;
      if (!known) throw new HttpError(404, 'Not found.');
      return { status: 200, body: await projectInfo(known.path) };
    }
    if (match('GET', '/api/models')) return { status: 200, body: await models() };
    if (match('POST', '/api/chats')) {
      const b = await readJson(req);
      const input: { provider: ProviderId; cwd: string; prompt: string; model?: string } = {
        provider: provider(b), cwd: str(b, 'cwd'), prompt: str(b, 'prompt'),
      };
      if (b.model !== undefined) {
        if (typeof b.model !== 'string' || b.model.trim() === '') throw new HttpError(400, 'Model must be a non-empty string.');
        input.model = b.model;
      }
      existingFolder(input.cwd);
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
    if ((m = match('GET', '/api/history/:provider/:ref/messages'))) {
      const id = m[0] as ProviderId;
      if (!PROVIDERS.includes(id)) throw new HttpError(400, 'Unknown provider. Use claude, codex or antigravity.');
      if (!opts.transcript) throw new HttpError(404, 'Not found.');
      return { status: 200, body: await opts.transcript(id, m[1]!) };
    }
    if (match('GET', '/api/history')) return { status: 200, body: await visibleHistory() };
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
    if (match('GET', '/api/connections')) return { status: 200, body: opts.connections?.latest() ?? [] };
    if (match('POST', '/api/connections/check')) {
      const b = await readJson(req);
      const only = b.provider === undefined ? undefined : provider(b);
      return { status: 200, body: (await opts.connections?.check(only)) ?? [] };
    }
    if (match('POST', '/api/folders/pick')) {
      if (!opts.folderPicker) throw new HttpError(404, 'Not found.');
      return { status: 200, body: { path: await opts.folderPicker.pick() } };
    }
    if (match('GET', '/api/connect')) return { status: 200, body: opts.connect?.states() ?? [] };
    if ((m = match('POST', '/api/connect/:provider/:action'))) {
      const id = m[0] as ProviderId;
      if (!PROVIDERS.includes(id)) throw new HttpError(400, 'Unknown provider. Use claude, codex or antigravity.');
      const c = opts.connect;
      if (!c) throw new HttpError(404, 'Not found.');
      const actions: Record<string, () => unknown> = {
        install: () => c.install(id), signin: () => c.signIn(id), signout: () => c.signOut(id),
        update: () => c.update(id), cancel: () => c.cancel(id), open: () => c.openSignInPage(id),
      };
      const run = Object.hasOwn(actions, m[1]!) ? actions[m[1]!] : undefined;
      if (!run) throw new HttpError(404, 'Not found.');
      return { status: 202, body: await run() };
    }
    if (match('GET', '/api/settings')) {
      if (!settings) throw new HttpError(404, 'Not found.');
      return { status: 200, body: settings.get() };
    }
    if (match('PATCH', '/api/settings')) {
      if (!settings) throw new HttpError(404, 'Not found.');
      const b = await readJson(req);
      let next;
      try { next = settings.patch(b); } catch (e) {
        if (e instanceof SettingsError) throw new HttpError(400, e.message);
        throw e;
      }
      // Other open pages (a second tab) follow the change.
      broadcast({ type: 'settings.updated', settings: next });
      return { status: 200, body: next };
    }
    throw new HttpError(404, 'Not found.');
  }

  const server = http.createServer((req, res) => {
    const origin = allowedOrigin(req.headers.origin);
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    }
    const send = (status: number, body?: unknown) => {
      if (body === undefined) { res.writeHead(status); res.end(); return; }
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    // Answer a too-large body only once the client has finished sending it (bounded), so it reads the 413
    // instead of a connection reset; the connection is then closed.
    const reject413 = (message: string) => {
      let done = false;
      const reply = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        res.setHeader('Connection', 'close');
        send(413, { error: message });
      };
      const timer = setTimeout(reply, DRAIN_MS);
      if (req.complete) return reply();
      let drained = 0;
      req.on('data', (c: Buffer) => { drained += c.length; if (drained > MAX_DRAIN) reply(); });
      req.on('end', reply);
      req.on('error', reply);
      req.resume();
    };
    if (req.method === 'OPTIONS') return send(204);
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://127.0.0.1'); } catch { return send(404, { error: 'Not found.' }); }
    const wantsHtml = (req.headers.accept ?? '').includes('text/html');
    const sendFile = (file: string, cache: string) => {
      const { body, type } = readStatic(file);
      // The shell's URL can carry ?token=: never send it on as a referrer.
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache, 'Content-Length': body.length, 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    const apiPath = url.pathname === '/ws' || url.pathname === '/api' || url.pathname.startsWith('/api/');
    // The built web app and its files carry no data, so they need no token.
    if ((req.method === 'GET' || req.method === 'HEAD') && !apiPath && url.pathname !== '/console') {
      const shell = shellFile(dist);
      const file = url.pathname === '/' ? null : staticFile(dist, url.pathname);
      if (file) return sendFile(file, url.pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
      if (shell && wantsHtml) return sendFile(shell, 'no-store');
    }
    const auth = req.headers.authorization;
    let given = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    // ?token= is accepted only for the landing pages the server prints (and the WebSocket upgrade).
    const landing = req.method === 'GET' && (url.pathname === '/' || url.pathname === '/console');
    if (!given && landing) given = url.searchParams.get('token');
    if (!tokenOk(given, token)) return send(401, { error: 'Missing or wrong token.' });
    if (landing) {
      // Browsers get the live console; scripts asking for text still get the plain line.
      res.writeHead(200, { 'Content-Type': wantsHtml ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      res.end(wantsHtml ? statusPageHtml() : 'Agent Kanban server is running.');
      return;
    }
    route(req, url).then(
      (r) => send(r.status, r.body),
      (err: unknown) => {
        if (err instanceof URIError) return send(404, { error: 'Not found.' });
        if (err instanceof HttpError) {
          if (err.status === 413) return reject413(err.message);
          return send(err.status, { error: err.message });
        }
        const msg = err instanceof Error ? err.message : '';
        if (err instanceof ActiveElsewhereError || err instanceof CantContinueError || err instanceof ConnectBusyError || err instanceof ConnectStateError || err instanceof PickerBusyError) return send(409, { error: msg });
        if (msg === 'That request is no longer open.') return send(409, { error: msg });
        if (msg === 'Chat not found.') return send(404, { error: msg });
        console.error(err);
        send(500, { error: 'Something went wrong.' });
      },
    );
  });

  server.on('upgrade', (req, socket, head) => {
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://127.0.0.1'); } catch {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
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
