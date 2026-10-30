import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { readTranscript } from '../src/history/transcript.ts';

const CLAUDE_ID = '11111111-2222-3333-4444-555555555555';
const CODEX_ID = '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000';
const lines = (rs: unknown[]) => rs.map((r) => JSON.stringify(r)).join('\n') + '\n';

function home(): string {
  const h = mkdtempSync(join(tmpdir(), 'ak-transcript-'));
  const proj = join(h, '.claude', 'projects', 'C--work-app');
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, `${CLAUDE_ID}.jsonl`), lines([
    { type: 'user', timestamp: '2026-10-27T10:00:00Z', message: { content: 'Fix the login bug' } },
    { type: 'assistant', timestamp: '2026-10-27T10:00:05Z', message: { id: 'm1', content: [{ type: 'thinking', thinking: 'hmm' }] } },
    { type: 'assistant', timestamp: '2026-10-27T10:00:06Z', message: { id: 'm1', content: [{ type: 'text', text: 'Looking at it.' }] } },
    { type: 'assistant', timestamp: '2026-10-27T10:00:07Z', message: { id: 'm1', content: [{ type: 'tool_use', name: 'Read' }] } },
    { type: 'user', timestamp: '2026-10-27T10:00:08Z', message: { content: [{ type: 'tool_result', content: 'file text' }] } },
    { type: 'assistant', timestamp: '2026-10-27T10:00:09Z', message: { id: 'm1', content: [{ type: 'text', text: 'Found it.' }] } },
    { type: 'assistant', timestamp: '2026-10-27T10:00:10Z', message: { id: 'm2', content: [{ type: 'text', text: 'Fixed **login**.' }] } },
    { type: 'user', message: { content: [{ type: 'image', source: {} }, { type: 'text', text: 'What is in this screenshot?' }] } },
    { type: 'user', message: { content: '<div> renders twice, why?' } },
    { type: 'user', isCompactSummary: true, message: { content: 'This session is being continued from a previous conversation…' } },
    { type: 'user', isMeta: true, message: { content: 'meta' } },
    { type: 'user', message: { content: '<command-name>/clear</command-name>' } },
    { type: 'user', isSidechain: true, message: { content: 'subagent prompt' } },
    'not json',
    { type: 'custom-title', customTitle: 'Login' },
  ]));
  const day = join(h, '.codex', 'sessions', '2026', '10', '27');
  mkdirSync(day, { recursive: true });
  const msg = (role: string, type: string, ...texts: string[]) => ({ type: 'response_item', timestamp: '2026-10-27T11:00:00Z', payload: { type: 'message', role, content: texts.map((text) => ({ type, text })) } });
  writeFileSync(join(day, `rollout-2026-10-27T11-00-00-${CODEX_ID}.jsonl.zst`), zstdCompressSync(Buffer.from(lines([
    { type: 'session_meta', payload: { cwd: '/work/app' } },
    msg('developer', 'input_text', '<permissions>…</permissions>'),
    msg('user', 'input_text', '<environment_context>cwd</environment_context>', 'Add a test'),
    msg('user', 'input_text', '# AGENTS.md instructions for /work/app\n\nBe terse.'),
    msg('user', 'input_text', '# Files mentioned by the user:\n\n## a.ts'),
    msg('user', 'input_text', '# In app browser:\n- url'),
    { type: 'response_item', payload: { type: 'function_call', name: 'shell' } },
    msg('assistant', 'output_text', 'Added it.'),
  ]))));
  return h;
}

test('Claude: typed prompts and reply text only, one reply per message id, in order (#16)', async () => {
  const t = await readTranscript(home(), 'claude', CLAUDE_ID);
  assert.equal(t.unavailable, false);
  assert.equal(t.truncated, false);
  assert.deepEqual(t.messages.map((m) => [m.role, m.text]), [
    ['user', 'Fix the login bug'],
    ['assistant', 'Looking at it.\n\nFound it.'],
    ['assistant', 'Fixed **login**.'],
    ['user', 'What is in this screenshot?'],
    ['user', '<div> renders twice, why?'],
  ]);
  assert.equal(t.messages[0]!.at, '2026-10-27T10:00:00.000Z');
});

test('Codex: user and assistant messages from the rollout, without injected context or developer text (#16)', async () => {
  const t = await readTranscript(home(), 'codex', CODEX_ID);
  assert.deepEqual(t.messages.map((m) => [m.role, m.text]), [['user', 'Add a test'], ['assistant', 'Added it.']]);
});

test('only the last messages are returned, marked truncated', async () => {
  const t = await readTranscript(home(), 'claude', CLAUDE_ID, 2);
  assert.equal(t.truncated, true);
  assert.deepEqual(t.messages.map((m) => m.text), ['What is in this screenshot?', '<div> renders twice, why?']);
});

test('unknown chats, Antigravity and path-like session refs are unavailable, never read', async () => {
  const h = home();
  for (const [p, ref] of [['claude', '99999999-0000-0000-0000-000000000000'], ['codex', 'nope'], ['antigravity', 'abc'], ['claude', '../../etc/passwd'], ['claude', 'a/b'], ['claude', '']] as const) {
    assert.deepEqual(await readTranscript(h, p, ref), { messages: [], truncated: false, unavailable: true }, `${p} ${ref}`);
  }
});
