// Fake `codex app-server` speaking line-delimited JSON-RPC on stdio.
// FAKE_SCENARIO: approval | fileapproval | crash | limits | hang | hanginit | tools | limit | slowturn | dieonaccount | hangaccount | hangbusy | chatterhang
// FAKE_SIGNED_OUT=1 makes account/read report no account; FAKE_RESUME_DELAY_MS delays thread/resume answers.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';

const scenario = process.env.FAKE_SCENARIO ?? '';
const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + '\n');
const note = (method: string, params: unknown) => send({ method, params });
const T = 'thr_1';
const known = new Set<string>(); // threads started/resumed in this process's lifetime

const limits = {
  rateLimits: {
    limitId: 'codex', limitName: null,
    primary: { usedPercent: 69, windowDurationMins: 300, resetsAt: 1792680600 },
    secondary: { usedPercent: 82, windowDurationMins: 10080, resetsAt: 1792944000 },
  },
  rateLimitsByLimitId: null,
};

function finishTurn() {
  note('item/completed', { threadId: T, turnId: 'turn_1', item: { type: 'agentMessage', id: 'item_1', text: 'Hello world' } });
  note('turn/completed', { threadId: T, turn: { id: 'turn_1', status: 'completed', error: null } });
}

function runTurn() {
  note('turn/started', { threadId: T, turn: { id: 'turn_1' } });
  if (scenario === 'crash') process.exit(1);
  if (scenario === 'hang' || scenario === 'slowturn' || scenario === 'hangbusy') return;
  if (scenario === 'limit') {
    note('account/rateLimits/updated', { rateLimits: { ...limits.rateLimits, rateLimitReachedType: 'rate_limit_reached' } });
    return;
  }
  if (scenario === 'tools') {
    note('item/started', { threadId: T, turnId: 'turn_1', item: { type: 'commandExecution', id: 'cmd_1', command: 'ls', status: 'inProgress' } });
    note('item/completed', { threadId: T, turnId: 'turn_1', item: { type: 'commandExecution', id: 'cmd_1', command: 'ls', status: 'completed' } });
    note('item/completed', { threadId: T, turnId: 'turn_1', item: { type: 'fileChange', id: 'fc_1', changes: [{ path: 'a.txt', kind: 'update', diff: '' }], status: 'failed' } });
    return finishTurn();
  }
  note('item/agentMessage/delta', { threadId: T, turnId: 'turn_1', itemId: 'item_1', delta: 'Hello ' });
  note('item/agentMessage/delta', { threadId: T, turnId: 'turn_1', itemId: 'item_1', delta: 'world' });
  if (scenario === 'approval') {
    send({ id: 900, method: 'item/commandExecution/requestApproval', params: { threadId: T, turnId: 'turn_1', itemId: 'cmd_1', command: 'npm test' } });
    return;
  }
  if (scenario === 'fileapproval') {
    send({ id: 901, method: 'item/fileChange/requestApproval', params: { threadId: T, turnId: 'turn_1', itemId: 'fc_1', reason: 'Edit a.txt' } });
    return;
  }
  finishTurn();
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  if (m.method === undefined) {
    // response to our approval request: only finish when the decision is 'accept'
    if ((m.id === 900 || m.id === 901) && m.result?.decision === 'accept') finishTurn();
    return;
  }
  if (m.id === undefined) return; // notification (initialized)
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify({ method: m.method, params: m.params }) + '\n');
  switch (m.method) {
    case 'model/list':
      if (process.env.FAKE_MODEL_PAGES) {
        const pages = JSON.parse(process.env.FAKE_MODEL_PAGES) as unknown[][];
        const i = m.params?.cursor ? Number(String(m.params.cursor).slice(1)) : 0;
        return send({ id: m.id, result: { data: pages[i] ?? [], nextCursor: i + 1 < pages.length ? `p${i + 1}` : null } });
      }
      return send({ id: m.id, result: { data: JSON.parse(process.env.FAKE_MODELS ?? '[]') } });
    case 'initialize':
      if (scenario === 'hanginit') return; // never answers
      return send({ id: m.id, result: { userAgent: 'fake' } });
    case 'thread/start': known.add(T); return send({ id: m.id, result: { thread: { id: T } } });
    case 'thread/resume': {
      known.add(m.params.threadId);
      const answer = () => send({ id: m.id, result: { thread: { id: m.params.threadId } } });
      const delay = Number(process.env.FAKE_RESUME_DELAY_MS ?? 0);
      return delay > 0 ? void setTimeout(answer, delay) : answer();
    }
    case 'account/read':
      if (scenario === 'dieonaccount') process.exit(1);
      if (scenario === 'chatterhang') { setTimeout(() => note('account/updated', {}), 60); return; } // never answers, but is not silent
      if (scenario === 'hangaccount' || scenario === 'hangbusy') return;
      return send({ id: m.id, result: { account: process.env.FAKE_SIGNED_OUT ? null : { type: 'chatgpt', email: 'a@b.c', planType: 'plus' }, requiresOpenaiAuth: true } });
    case 'turn/start': {
      if (!known.has(m.params.threadId)) return send({ id: m.id, error: { code: -32600, message: 'thread not found' } });
      const reply = () => { send({ id: m.id, result: { turn: { id: 'turn_1' } } }); setTimeout(runTurn, 10); };
      // slowturn: both the response and turn/started arrive late
      if (scenario === 'slowturn') return void setTimeout(() => { send({ id: m.id, result: { turn: { id: 'turn_1' } } }); note('turn/started', { threadId: T, turn: { id: 'turn_1' } }); }, 250);
      return reply();
    }
    case 'turn/interrupt':
      // Only the exact expected params produce an interrupted turn
      if (m.params?.threadId !== T || m.params?.turnId !== 'turn_1') return send({ id: m.id, error: { code: -32602, message: 'bad params' } });
      send({ id: m.id, result: {} });
      {
        // FAKE_INTERRUPT_DELAY_MS: the real app-server answers the interrupt before the turn has actually ended.
        const end = () => note('turn/completed', { threadId: T, turn: { id: 'turn_1', status: 'interrupted', error: null } });
        const delay = Number(process.env.FAKE_INTERRUPT_DELAY_MS ?? 0);
        return delay > 0 ? void setTimeout(end, delay) : end();
      }
    case 'account/rateLimits/read':
      return scenario === 'limits'
        ? send({ id: m.id, result: { ...limits, rateLimitResetCredits: { availableCount: 2, credits: null } } })
        : send({ id: m.id, error: { code: -32000, message: 'not signed in' } });
    case 'account/rateLimitResetCredit/consume':
      return typeof m.params?.idempotencyKey === 'string' && scenario === 'limits'
        ? send({ id: m.id, result: { outcome: 'reset' } })
        : send({ id: m.id, error: { code: -32000, message: 'no key' } });
    default: return send({ id: m.id, error: { code: -32601, message: 'unknown method' } });
  }
});
