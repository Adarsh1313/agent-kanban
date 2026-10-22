import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextState } from '../src/columns.ts';
const S = (column, needsReason = null) => ({ column, needsReason });
const ref = { sessionRef: 's1' };

test('user message → running', () => assert.deepEqual(nextState(S('review'), { type: 'user.message' }), S('running')));
test('request.opened permission → needs_you/permission', () =>
  assert.deepEqual(nextState(S('running'), { type: 'request.opened', ...ref, requestId: 'r', kind: 'permission', summary: '' }), S('needs_you', 'permission')));
test('request.opened question → needs_you/question', () =>
  assert.deepEqual(nextState(S('running'), { type: 'request.opened', ...ref, requestId: 'r', kind: 'question', summary: '' }), S('needs_you', 'question')));
test('limit.reached → needs_you/limit', () => assert.deepEqual(nextState(S('running'), { type: 'limit.reached', ...ref }), S('needs_you', 'limit')));
test('error → needs_you/error', () => assert.deepEqual(nextState(S('running'), { type: 'error', ...ref, message: 'x' }), S('needs_you', 'error')));
test('turn.completed → review', () => assert.deepEqual(nextState(S('running'), { type: 'turn.completed', ...ref }), S('review')));
test('turn.completed while a request is open stays in needs_you', () =>
  assert.deepEqual(nextState(S('needs_you', 'permission'), { type: 'turn.completed', ...ref }), S('needs_you', 'permission')));
test('user answered → running', () => assert.deepEqual(nextState(S('needs_you', 'question'), { type: 'user.answered' }), S('running')));
test('user stop → needs_you/stopped', () => assert.deepEqual(nextState(S('running'), { type: 'user.stop' }), S('needs_you', 'stopped')));
test('mark done → done', () => assert.deepEqual(nextState(S('review'), { type: 'user.markDone' }), S('done')));
test('agent events never move a card out of done', () => {
  for (const e of [{ type: 'turn.completed', ...ref }, { type: 'error', ...ref, message: 'x' }, { type: 'turn.started', ...ref }])
    assert.deepEqual(nextState(S('done'), e), S('done'));
});
test('dragging out of done → review', () => assert.deepEqual(nextState(S('done'), { type: 'user.dragOut' }), S('review')));
test('restart: running → needs_you/interrupted; others unchanged', () => {
  assert.deepEqual(nextState(S('running'), { type: 'app.restarted' }), S('needs_you', 'interrupted'));
  assert.deepEqual(nextState(S('review'), { type: 'app.restarted' }), S('review'));
});
test('message deltas and tool calls do not change the column', () =>
  assert.deepEqual(nextState(S('running'), { type: 'tool.call', ...ref, toolCallId: 't', name: 'Edit', summary: '', status: 'running' }), S('running')));
