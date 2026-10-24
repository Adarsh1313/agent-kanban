// Fake ACP agent (like agy_acp_server) speaking line-delimited JSON-RPC 2.0 on stdio.
// FAKE_SCENARIO: ready | signin | turn | permission | crash | cancel | permcancel | unknownreq | badstop
//   permcancel: like permission, but after session/cancel the turn ends 'cancelled' once the permission answer arrives
//   unknownreq: sends an fs/read_text_file request and reports the error code it got back
//   badstop: ends the turn with no stopReason
// FAKE_AUTH_URL overrides the URL printed by the signin scenario.
// FAKE_AUTH_STREAM=stderr prints the sign-in line on stderr (like the real agy_acp_server 1.3.0).
// FAKE_AUTH_HANG=1: authenticate prints the link and never answers (the user hasn't finished in the browser).
// FAKE_NO_AUTH_FLAG=1: initialize sends no "authenticated" flag (like the real server).
// FAKE_LOADABLE: comma-separated session ids session/load accepts (default sess_old).
// FAKE_NEW_SIGNIN=1: session/new prints a sign-in link on stderr and never answers (a selected login that's gone).
// FAKE_PERM_OPTIONS=always: the permission request offers allow_always (no allow_once) and reject_once.
// FAKE_NEW_DELAY_MS: session/new answers after this delay.
// FAKE_VERSION: agentInfo.version (default 1.3.0).
// FAKE_STOP: the stop reason the default turn ends with (default end_turn).
// Strict about framing: any incoming message without "jsonrpc":"2.0" is rejected (requests) or ignored.
import { createInterface } from 'node:readline';

const scenario = process.env.FAKE_SCENARIO ?? 'ready';
const send = (m: object) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const reply = (id: unknown, result: unknown) => send({ id, result });
const fail = (id: unknown, code: number, message: string) => send({ id, error: { code, message } });
const update = (sessionId: string, u: object) => send({ method: 'session/update', params: { sessionId, update: u } });
const chunk = (sessionId: string, text: string) => update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });

const GOOGLE_URL = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=fake&redirect_uri=http%3A%2F%2F127.0.0.1%3A51234%2F&response_type=code&scope=openid';
let authenticated = scenario !== 'signin';
const sessions = new Set<string>();
let pendingPrompt: { id: unknown; sessionId: string } | null = null;
let cancelRequested = false;
const PERM_ID = 'perm-1';

function onPrompt(id: unknown, sessionId: string) {
  if (!sessions.has(sessionId)) return fail(id, -32602, 'unknown session');
  if (scenario === 'crash') { chunk(sessionId, 'Starting'); process.exit(1); }
  if (scenario === 'cancel') { chunk(sessionId, 'Working'); pendingPrompt = { id, sessionId }; return; }
  if (scenario === 'badstop') return reply(id, {});
  if (scenario === 'unknownreq') {
    pendingPrompt = { id, sessionId };
    send({ id: 'u1', method: 'fs/read_text_file', params: { sessionId, path: '/etc/passwd' } });
    return;
  }
  if (scenario === 'permission' || scenario === 'permcancel') {
    pendingPrompt = { id, sessionId };
    send({ id: PERM_ID, method: 'session/request_permission', params: {
      sessionId,
      toolCall: { toolCallId: 'call_1', title: 'Run npm test', kind: 'execute', status: 'pending' },
      options: process.env.FAKE_PERM_OPTIONS === 'always'
        ? [{ optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' }, { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' }]
        : [
          { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
        ],
    } });
    return;
  }
  chunk(sessionId, 'Hello ');
  chunk(sessionId, 'world');
  update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'call_1', title: 'Read a.txt', kind: 'read', status: 'pending' });
  update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'completed' });
  reply(id, { stopReason: process.env.FAKE_STOP ?? 'end_turn' });
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  if (m.jsonrpc !== '2.0') {
    if (m.id !== undefined && m.method !== undefined) fail(m.id, -32600, 'missing jsonrpc 2.0');
    return;
  }
  if (m.method === undefined) {
    // a response to our permission request
    if (m.id === PERM_ID && pendingPrompt) {
      const o = m.result?.outcome;
      const picked = o?.outcome === 'selected' ? o.optionId : 'cancelled';
      chunk(pendingPrompt.sessionId, `permission: ${picked}`);
      reply(pendingPrompt.id, { stopReason: cancelRequested ? 'cancelled' : 'end_turn' });
      pendingPrompt = null;
    }
    if (m.id === 'u1' && pendingPrompt) {
      chunk(pendingPrompt.sessionId, `error: ${m.error?.code}`);
      reply(pendingPrompt.id, { stopReason: 'end_turn' });
      pendingPrompt = null;
    }
    return;
  }
  const p = m.params ?? {};
  switch (m.method) {
    case 'test/echo': return reply(m.id, m);
    case 'initialize':
      return reply(m.id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        agentInfo: { name: 'fake-agy', version: process.env.FAKE_VERSION ?? '1.3.0' },
        authMethods: [{ id: 'google', name: 'Sign in with Google', description: null }],
        ...(process.env.FAKE_NO_AUTH_FLAG === '1' ? {} : { authenticated }),
      });
    case 'authenticate':
      if (p.methodId !== 'google') return fail(m.id, -32602, 'unknown auth method');
      {
        const out = process.env.FAKE_AUTH_STREAM === 'stderr' ? process.stderr : process.stdout;
        out.write('Starting sign-in...\n');
        out.write(`Open the following link to authenticate the ACP server: ${process.env.FAKE_AUTH_URL ?? GOOGLE_URL}\n`);
      }
      if (process.env.FAKE_AUTH_HANG === '1') return;
      authenticated = true;
      return reply(m.id, {});
    case 'session/new': {
      if (process.env.FAKE_NEW_SIGNIN === '1') {
        process.stderr.write(`Open the following link to authenticate the ACP server: ${GOOGLE_URL}
`);
        return;
      }
      if (!authenticated) return fail(m.id, -32000, 'Authentication required');
      const id = `sess_${sessions.size + 1}`;
      sessions.add(id);
      const delay = Number(process.env.FAKE_NEW_DELAY_MS ?? 0);
      if (delay > 0) { setTimeout(() => reply(m.id, { sessionId: id }), delay); return; }
      return reply(m.id, { sessionId: id });
    }
    case 'session/load':
      if (!(process.env.FAKE_LOADABLE ?? 'sess_old').split(',').includes(p.sessionId)) return fail(m.id, -32002, 'session not found');
      sessions.add(p.sessionId);
      chunk(p.sessionId, 'replayed');
      return reply(m.id, null);
    case 'session/prompt': return onPrompt(m.id, p.sessionId);
    case 'session/cancel':
      if (scenario === 'permcancel') { cancelRequested = true; return; }
      if (pendingPrompt && pendingPrompt.sessionId === p.sessionId) {
        reply(pendingPrompt.id, { stopReason: 'cancelled' });
        pendingPrompt = null;
      }
      return;
    default:
      if (m.id !== undefined) fail(m.id, -32601, `method not found: ${m.method}`);
  }
});
