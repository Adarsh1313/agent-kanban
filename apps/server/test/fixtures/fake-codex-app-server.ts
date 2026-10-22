// Fake `codex app-server` speaking line-delimited JSON-RPC on stdio. FAKE_SCENARIO: approval | crash | limits | hang
import { createInterface } from 'node:readline';

const scenario = process.env.FAKE_SCENARIO ?? '';
const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + '\n');
const note = (method: string, params: unknown) => send({ method, params });
const T = 'thr_1';

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
  if (scenario === 'hang') return;
  note('item/agentMessage/delta', { threadId: T, turnId: 'turn_1', itemId: 'item_1', delta: 'Hello ' });
  note('item/agentMessage/delta', { threadId: T, turnId: 'turn_1', itemId: 'item_1', delta: 'world' });
  if (scenario === 'approval') {
    send({ id: 900, method: 'item/commandExecution/requestApproval', params: { threadId: T, turnId: 'turn_1', itemId: 'cmd_1', command: 'npm test' } });
    return;
  }
  finishTurn();
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  if (m.method === undefined) {
    // response to our approval request: only finish when the decision is 'accept'
    if (m.id === 900 && m.result?.decision === 'accept') finishTurn();
    return;
  }
  if (m.id === undefined) return; // notification (initialized)
  switch (m.method) {
    case 'initialize': return send({ id: m.id, result: { userAgent: 'fake' } });
    case 'thread/start': return send({ id: m.id, result: { thread: { id: T } } });
    case 'thread/resume': return send({ id: m.id, result: { thread: { id: m.params.threadId } } });
    case 'turn/start': send({ id: m.id, result: { turn: { id: 'turn_1' } } }); return void setTimeout(runTurn, 10);
    case 'turn/interrupt':
      // Only the exact expected params produce an interrupted turn
      if (m.params?.threadId !== T || m.params?.turnId !== 'turn_1') return send({ id: m.id, error: { code: -32602, message: 'bad params' } });
      send({ id: m.id, result: {} });
      return note('turn/completed', { threadId: T, turn: { id: 'turn_1', status: 'interrupted', error: null } });
    case 'account/rateLimits/read':
      return scenario === 'limits'
        ? send({ id: m.id, result: limits })
        : send({ id: m.id, error: { code: -32000, message: 'not signed in' } });
    default: return send({ id: m.id, error: { code: -32601, message: 'unknown method' } });
  }
});
