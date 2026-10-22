import type { AdapterEvent, ChatState, UserAction } from '@agent-kanban/shared';

const RUNNING: ChatState = { column: 'running', needsReason: null };
const REVIEW: ChatState = { column: 'review', needsReason: null };
const DONE: ChatState = { column: 'done', needsReason: null };

export function nextState(current: ChatState, event: AdapterEvent | UserAction): ChatState {
  // Only the user moves a card out of done.
  if (current.column === 'done') {
    switch (event.type) {
      case 'user.message':
        return RUNNING;
      case 'user.dragOut':
        return REVIEW;
      default:
        return current;
    }
  }

  switch (event.type) {
    case 'user.message':
    case 'user.answered':
    case 'turn.started':
      return RUNNING;
    case 'request.opened':
      return { column: 'needs_you', needsReason: event.kind };
    case 'limit.reached':
      return { column: 'needs_you', needsReason: 'limit' };
    case 'error':
      return { column: 'needs_you', needsReason: 'error' };
    case 'user.stop':
    case 'stopped':
      return { column: 'needs_you', needsReason: 'stopped' };
    case 'turn.completed':
      return current.column === 'needs_you' ? current : REVIEW;
    case 'user.markDone':
      return DONE;
    case 'app.restarted':
      return current.column === 'running' ? { column: 'needs_you', needsReason: 'interrupted' } : current;
    default:
      return current;
  }
}
