import type { Chat, Message } from '@agent-kanban/shared';

export function chat(over: Partial<Chat> = {}): Chat {
  return {
    id: 'c1',
    provider: 'claude',
    sessionRef: 's1',
    cwd: '/work/alpha',
    title: 'A chat',
    model: 'sonnet',
    column: 'running',
    needsReason: null,
    createdAt: '2026-10-23T09:00:00.000Z',
    updatedAt: '2026-10-23T10:00:00.000Z',
    doneAt: null,
    archived: false,
    pinned: false,
    snoozedUntil: null,
    effort: 'normal',
    ...over,
  };
}

export function message(over: Partial<Message> = {}): Message {
  return { id: 'm1', chatId: 'c1', role: 'assistant', text: 'hello', createdAt: '2026-10-23T10:00:00.000Z', ...over };
}
