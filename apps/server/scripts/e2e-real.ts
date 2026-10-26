// Real end-to-end check against the user's installed Claude Code, Codex and Antigravity. Run ONCE: uses real subscriptions.
// Usage: AGENT_KANBAN_HOME=<temp folder> node apps/server/scripts/e2e-real.ts   (E2E_ONLY=f runs only step f)
// Every chat runs in a NEW temp folder. Set AGENT_KANBAN_HOME to a temp folder so the run gets its own database
// and Antigravity install instead of the user's ~/.agent-kanban; step f only installs Antigravity there, and it
// never starts a sign-in (a signed-out Antigravity fails the step with a note instead).
// Without AGENT_KANBAN_HOME it refuses to run unless E2E_ALLOW_REAL_HOME=1 (then it uses the real ~/.agent-kanban).
// The temp chat folders it makes are removed at the end, pass or fail.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocket } from 'ws';

const akHome = process.env.AGENT_KANBAN_HOME ? resolve(process.env.AGENT_KANBAN_HOME) : null;
if (!akHome) {
  if (process.env.E2E_ALLOW_REAL_HOME !== '1') {
    console.error('Set AGENT_KANBAN_HOME to a temp folder (or E2E_ALLOW_REAL_HOME=1 to use your real ~/.agent-kanban database).');
    process.exit(1);
  }
  console.warn('E2E_ALLOW_REAL_HOME=1: this run uses your real ~/.agent-kanban database (chats still run in temp folders; step f will not install Antigravity).');
}

/** Temp chat folders made by this run; removed in the finally below. */
const tempDirs: string[] = [];
const tempDir = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); tempDirs.push(d); return d; };

type Ev = { type: string; [k: string]: any };
const log = (s: string) => console.log(s);
const results: string[] = [];

// AGENT_KANBAN_E2E=1: closing the child's stdin shuts the server down gracefully (adapters disposed, lock removed).
const server = spawn(process.execPath, ['apps/server/src/main.ts'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, AGENT_KANBAN_E2E: '1' } });
let stderrTail = '';
server.stderr.on('data', (d) => { stderrTail = (stderrTail + String(d)).slice(-1500); });

const url: string = await new Promise((resolve, reject) => {
  let buf = '';
  const t = setTimeout(() => reject(new Error('server did not print its URL in 30s. stderr: ' + stderrTail)), 30_000);
  server.stdout.on('data', (d) => {
    buf += String(d);
    const m = /Agent Kanban server: (http:\/\/127\.0\.0\.1:\d+)\/\?token=([0-9a-f]+)/.exec(buf);
    if (m) { clearTimeout(t); resolve(m[1] + '|' + m[2]); }
  });
  server.on('exit', (c) => reject(new Error('server exited early: ' + c + ' ' + stderrTail)));
});
const [base, token] = url.split('|') as [string, string];
log(`server up at ${base}`);

const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
};

const chatState = new Map<string, { column: string | null; reason: string | null }>();
const lastText = new Map<string, string>();
const opened = new Set<string>();
const questions: { chatId: string; summary: string; openBeforeAnswer: number; status: number }[] = [];
const ws = new WebSocket(`ws://${base.replace('http://', '')}/ws?token=${token}`);
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
const t0 = Date.now();
ws.on('message', (d) => {
  const e: Ev = JSON.parse(String(d));
  const at = ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
  if (e.type === 'chat.updated') {
    chatState.set(e.chat.id, { column: e.chat.column, reason: e.chat.needsReason });
    log(`${at}s chat.updated ${e.chat.provider} ${e.chat.column}${e.chat.needsReason ? '/' + e.chat.needsReason : ''}`);
  } else if (e.type === 'request.opened') {
    log(`${at}s request.opened ${e.kind}`);
    if (!opened.has(e.requestId)) {
      opened.add(e.requestId);
      if (e.kind === 'question') {
        // Read the open request back over the API (as a reloaded page would), then answer it with text.
        void (async () => {
          const open = await api('GET', `/api/chats/${e.chatId}/requests`);
          const r = await api('POST', `/api/chats/${e.chatId}/requests/${e.requestId}`, { decision: { reply: 'a.txt' } });
          questions.push({ chatId: e.chatId, summary: e.summary, openBeforeAnswer: (open.json as unknown[]).length, status: r.status });
          log(`${at}s   question "${e.summary}" (open via API: ${(open.json as unknown[]).length}) answered "a.txt" -> ${r.status}`);
        })();
      } else {
        api('POST', `/api/chats/${e.chatId}/requests/${e.requestId}`, { decision: 'allow' })
          .then((r) => log(`${at}s   answered allow -> ${r.status}`));
      }
    }
  } else if (e.type === 'tool.call') {
    log(`${at}s tool.call ${e.toolCall.name} ${e.toolCall.status}`);
  } else if (e.type === 'message.completed') {
    lastText.set(e.chatId, String(e.message.text));
    log(`${at}s message.completed ${e.message.role} (${String(e.message.text).length} chars)`);
  } else if (e.type === 'usage.updated') {
    log(`${at}s usage.updated ${e.reading.provider} ${e.reading.status}`);
  } else if (e.type !== 'message.delta') {
    log(`${at}s ${e.type}`);
  }
});

async function waitFor(id: string, want: (s: { column: string | null; reason: string | null }) => boolean, ms = 240_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const s = chatState.get(id);
    if (s && want(s)) return s;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out; last state ${JSON.stringify(chatState.get(id))}; last message: ${(lastText.get(id) ?? '').slice(0, 200)}`);
}

async function step(name: string, fn: () => Promise<string>) {
  if (process.env.E2E_ONLY && !process.env.E2E_ONLY.split(',').includes(name[0]!)) return;
  log(`\n=== ${name}`);
  try { const r = await fn(); results.push(`PASS ${name}: ${r}`); }
  catch (e) { results.push(`FAIL ${name}: ${(e as Error).message}`); }
  log(results[results.length - 1]!);
}

// From here on the run makes temp chat folders: the finally removes them, pass or fail.
try {
  let codexChat: string | null = null;
  const codexDir = tempDir('ak-codex-');
  await step('a) codex create hello.txt', async () => {
    const r = await api('POST', '/api/chats', { provider: 'codex', cwd: codexDir, prompt: 'create hello.txt containing hi' });
    if (r.status !== 201) throw new Error(`POST /api/chats -> ${r.status} ${JSON.stringify(r.json)}`);
    codexChat = r.json.id;
    const s = await waitFor(codexChat!, (x) => x.column === 'review' || (x.column === 'needs_you' && x.reason !== 'permission' && x.reason !== 'question'));
    const exists = existsSync(join(codexDir, 'hello.txt'));
    if (s.column !== 'review') throw new Error(`ended in ${s.column}/${s.reason}; last message: ${(lastText.get(codexChat!) ?? '').slice(0, 200)}`);
    if (!exists) throw new Error('reached review but hello.txt is missing');
    return `review, hello.txt exists, requests answered: ${opened.size}`;
  });

  await step('b) codex stop mid-turn then follow-up', async () => {
    if (!codexChat) throw new Error('no codex chat from step a');
    const m = await api('POST', `/api/chats/${codexChat}/messages`, { text: 'Run the shell command "ping -n 15 127.0.0.1" and then tell me it finished.' });
    if (m.status !== 204) throw new Error(`send -> ${m.status} ${JSON.stringify(m.json)}`);
    await waitFor(codexChat, (x) => x.column === 'running', 60_000);
    await new Promise((r) => setTimeout(r, 3000));
    const stopped = await api('POST', `/api/chats/${codexChat}/stop`);
    log(`stop -> ${stopped.status} ${stopped.json?.column}/${stopped.json?.needsReason}`);
    const f = await api('POST', `/api/chats/${codexChat}/messages`, { text: 'say done' });
    if (f.status !== 204) throw new Error(`follow-up send -> ${f.status} ${JSON.stringify(f.json)}`);
    const s = await waitFor(codexChat, (x) => x.column === 'review' || x.reason === 'error', 180_000);
    if (s.column !== 'review') throw new Error(`follow-up ended in ${s.column}/${s.reason}; last message: ${(lastText.get(codexChat) ?? '').slice(0, 200)}`);
    return `stop gave ${stopped.json?.column}/${stopped.json?.needsReason}; follow-up reached review`;
  });

  await step('c) claude reply ok', async () => {
    const dir = tempDir('ak-claude-');
    const r = await api('POST', '/api/chats', { provider: 'claude', cwd: dir, prompt: 'reply with the single word ok' });
    if (r.status !== 201) throw new Error(`POST /api/chats -> ${r.status} ${JSON.stringify(r.json)}`);
    const s = await waitFor(r.json.id, (x) => x.column === 'review' || (x.column === 'needs_you' && x.reason !== 'permission' && x.reason !== 'question'));
    if (s.column !== 'review') throw new Error(`ended in ${s.column}/${s.reason}; last message: ${(lastText.get(r.json.id) ?? '').slice(0, 200)}`);
    return 'review';
  });

  await step('d) usage and history', async () => {
    const u = await api('POST', '/api/usage/refresh');
    const parts = (u.json.readings as any[]).map((x) => `${x.provider}:${x.status}[${x.windows.map((w: any) => `${w.kind} ${w.leftPct}% left`).join('; ')}]`);
    const h = await api('GET', '/api/history');
    return `usage ${parts.join(' | ')} suggested=${u.json.suggested}; history count=${(h.json as unknown[]).length}`;
  });

  await step('e) claude question round-trip', async () => {
    const dir = tempDir('ak-claude-q-');
    const r = await api('POST', '/api/chats', {
      provider: 'claude', cwd: dir,
      prompt: 'Use the AskUserQuestion tool to ask me whether to name the file a.txt or b.txt, then create that file containing the word hi. Do not ask in plain text.',
    });
    if (r.status !== 201) throw new Error(`POST /api/chats -> ${r.status} ${JSON.stringify(r.json)}`);
    const id = r.json.id as string;
    const s = await waitFor(id, (x) => x.column === 'review' || (x.column === 'needs_you' && x.reason !== 'permission' && x.reason !== 'question'));
    const q = questions.find((x) => x.chatId === id);
    const a = existsSync(join(dir, 'a.txt')); const b = existsSync(join(dir, 'b.txt'));
    const tools = await api('GET', `/api/chats/${id}/tool-calls`);
    const left = await api('GET', `/api/chats/${id}/requests`);
    const summary = `question ${q ? `asked ("${q.summary}", open via API ${q.openBeforeAnswer}, answer -> ${q.status})` : 'NOT triggered'}; `
      + `ended ${s.column}/${s.reason}; a.txt=${a} b.txt=${b}; tool calls ${(tools.json as unknown[]).length}; open requests after ${(left.json as unknown[]).length}; `
      + `last message: ${(lastText.get(id) ?? '').slice(0, 160).replace(/\s+/g, ' ')}`;
    if (s.column !== 'review') throw new Error(summary);
    return summary;
  });

  await step('f) antigravity create hello.txt', async () => {
    const health = async () => ((await api('GET', '/api/connections')).json as any[]).find((h) => h.provider === 'antigravity');
    let h = await health();
    let installNote = 'already installed';
    if (!h?.installed) {
      // Only into a temp Agent Kanban home: never download into the user's own ~/.agent-kanban from a test.
      if (!akHome) throw new Error('Antigravity is not installed and AGENT_KANBAN_HOME is not set; set it to a temp folder to let this step install it.');
      const started = Date.now();
      const r = await api('POST', '/api/connect/antigravity/install');
      if (r.status !== 202) throw new Error(`install -> ${r.status} ${JSON.stringify(r.json)}`);
      const end = Date.now() + 15 * 60_000;
      for (;;) {
        const c = ((await api('GET', '/api/connect')).json as any[]).find((s) => s.provider === 'antigravity');
        if (c.phase === 'idle' || c.phase === 'error') {
          if (c.outcome !== 'done') throw new Error(`install ended ${c.phase}/${c.outcome}: ${c.message}`);
          break;
        }
        if (Date.now() > end) throw new Error(`install still ${c.phase} after 15 min (${c.step})`);
        await new Promise((r2) => setTimeout(r2, 1000));
      }
      h = (await api('POST', '/api/connections/check', { provider: 'antigravity' })).json.find((x: any) => x.provider === 'antigravity');
      installNote = `installed in ${((Date.now() - started) / 1000).toFixed(0)} s`;
    }
    if (!h?.installed) throw new Error(`not installed after install: ${JSON.stringify(h)}`);
    // Never start a sign-in from a test: it would need the user in the browser.
    if (h.signedIn === false) throw new Error(`Antigravity is signed out (${h.message}); sign in from the app first. ${installNote}`);
    const dir = tempDir('ak-antigravity-');
    const started = Date.now();
    const r = await api('POST', '/api/chats', { provider: 'antigravity', cwd: dir, prompt: 'create hello.txt containing hi' });
    if (r.status !== 201) throw new Error(`POST /api/chats -> ${r.status} ${JSON.stringify(r.json)}`);
    const id = r.json.id as string;
    // A cold start of Google's agent can take ~2 minutes and session/new another ~40 s.
    const s = await waitFor(id, (x) => x.column === 'review' || (x.column === 'needs_you' && x.reason !== 'permission' && x.reason !== 'question'), 8 * 60_000);
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    if (s.column !== 'review') throw new Error(`ended in ${s.column}/${s.reason} after ${secs} s; last message: ${(lastText.get(id) ?? '').slice(0, 200)}`);
    // The agent must work in the chat's folder (1.3.0 otherwise picks ~/.gemini/antigravity-cli/skills).
    if (!existsSync(join(dir, 'hello.txt'))) throw new Error(`reached review after ${secs} s but hello.txt is not in ${dir}; last message: ${(lastText.get(id) ?? '').slice(0, 200)}`);
    return `${installNote}; review after ${secs} s, hello.txt in the chat folder, requests answered so far: ${opened.size}`;
  });

  log('\n=== SUMMARY');
  for (const r of results) log(r);
  ws.close();
  const exited = new Promise<number | null>((r) => server.once('exit', (code) => r(code)));
  server.stdin.end();
  const code = await Promise.race([exited, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 15_000))]);
  if (code === 'timeout') { log('server did not shut down within 15 s; killing it'); server.kill(); }
  else log(`server shut down gracefully (exit ${code}); lock left behind: ${existsSync(join(akHome ?? homedir(), '.agent-kanban', 'server.lock'))}`);
} finally {
  // Pass or fail: stop the server if it is still up, then delete this run's temp chat folders.
  if (server.exitCode === null && server.signalCode === null) server.kill();
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    catch (e) { console.warn(`could not remove ${d}: ${(e as Error).message}`); }
  }
}
setTimeout(() => process.exit(0), 1000).unref();
