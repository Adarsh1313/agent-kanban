export type ProviderId = 'claude' | 'codex' | 'antigravity';

export type Column = 'running' | 'needs_you' | 'review' | 'done';

export type NeedsReason = 'permission' | 'question' | 'limit' | 'error' | 'interrupted' | 'stopped';

export interface ChatState {
  column: Column;
  needsReason: NeedsReason | null;
}

export type AdapterEvent =
  | { type: 'session.started'; sessionRef: string }
  | { type: 'stopped'; sessionRef: string }
  | { type: 'turn.started'; sessionRef: string }
  | { type: 'message.delta'; sessionRef: string; messageId: string; text: string }
  | { type: 'message.completed'; sessionRef: string; messageId: string; role: 'assistant'; text: string }
  | { type: 'tool.call'; sessionRef: string; toolCallId: string; name: string; summary: string; status: 'running' | 'done' | 'failed' }
  | { type: 'request.opened'; sessionRef: string; requestId: string; kind: 'permission' | 'question'; summary: string }
  | { type: 'turn.completed'; sessionRef: string }
  | { type: 'limit.reached'; sessionRef: string; resetsAt?: string }
  | { type: 'error'; sessionRef: string; message: string };

export type UserAction =
  | { type: 'user.message' }
  | { type: 'user.answered' }
  | { type: 'user.stop' }
  | { type: 'user.markDone' }
  | { type: 'user.dragOut' }
  | { type: 'app.restarted' };
