import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Chat, ConnectionHealth, HistoryChat, ToolCall } from '@agent-kanban/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/api/client.ts';
import { applyEvent, applySnapshot, initialState, type AppState } from '../src/state/reducer.ts';
import { createStore, StoreProvider, type Store } from '../src/state/store.ts';
import { setHistoryHandler, setNewChatHandler, setRowMenuHandler } from '../src/ui/actions.ts';
import { Board } from '../src/ui/board/Board.tsx';
import { ANTIGRAVITY_STARTING, HINT_AGENT_COLUMNS, HINT_DONE_BACK, RESUME_TEXT } from '../src/ui/board/Card.tsx';
import { clockTime } from '../src/ui/board/format.ts';
import { flip } from '../src/ui/primitives/flip.ts';
import { Toasts } from '../src/ui/primitives/toast.tsx';
import { Popover } from '../src/ui/primitives/Popover.tsx';
import { chat } from './helpers.ts';

vi.mock('../src/api/client.ts', async (orig) => {
  const m = await orig<typeof import('../src/api/client.ts')>();
  return { ...m, api: { ...m.api, stop: vi.fn(), done: vi.fn(), undone: vi.fn(), send: vi.fn() } };
});
vi.mock('../src/ui/primitives/flip.ts', async (orig) => {
  const m = await orig<typeof import('../src/ui/primitives/flip.ts')>();
  return { flip: vi.fn(m.flip) };
});

const NOW = Date.parse('2026-10-23T12:00:00.000Z');
const mocked = api as unknown as Record<'stop' | 'done' | 'undone' | 'send', ReturnType<typeof vi.fn>>;

const connected: ConnectionHealth = {
  provider: 'codex', installed: true, path: null, version: null, latestVersion: null, updateAvailable: false, signedIn: true, processOk: true,
  status: 'connected', message: null, checkedAt: '2026-10-23T11:00:00.000Z',
};

function seeded(chats: Chat[], extra: Partial<AppState> = {}, history: HistoryChat[] = [], connections: ConnectionHealth[] = [connected]): Store {
  const s = applySnapshot(initialState(), { chats, usage: [], suggested: null, connections, history, projects: [] });
  return createStore({ ...s, now: NOW, ...extra });
}
const mount = (store: Store) => render(<StoreProvider store={store}><Board /><Toasts /></StoreProvider>);
const column = (name: string) => screen.getByRole('region', { name });
const card = (title: string) => screen.getByRole('article', { name: title });
const tool = (over: Partial<ToolCall>): ToolCall => ({ id: 't', chatId: 'c1', name: 'Bash', summary: 'Running npm test', status: 'done', createdAt: '2026-10-23T11:00:00.000Z', ...over });

beforeEach(() => {
  for (const k of ['stop', 'done', 'undone', 'send'] as const) mocked[k].mockReset();
  vi.mocked(flip).mockClear();
});
afterEach(() => {
  cleanup();
  setNewChatHandler(null);
  setHistoryHandler(null);
  setRowMenuHandler(null);
});

describe('Board: columns and cards', () => {
  it('renders each chat in its column with counts', () => {
    mount(seeded([
      chat({ id: 'r', title: 'Run it', column: 'running' }),
      chat({ id: 'n', title: 'Ask me', column: 'needs_you', needsReason: 'question', sessionRef: 's2' }),
      chat({ id: 'v', title: 'Check it', column: 'review', sessionRef: 's3' }),
      chat({ id: 'd', title: 'Finished', column: 'done', sessionRef: 's4' }),
      chat({ id: 'a', title: 'Archived', column: 'review', archived: true, sessionRef: 's5' }),
    ]));
    expect(within(column('Running')).getByRole('article', { name: 'Run it' })).toBeTruthy();
    expect(within(column('Needs you')).getByRole('article', { name: 'Ask me' })).toBeTruthy();
    expect(within(column('Review')).getByRole('article', { name: 'Check it' })).toBeTruthy();
    expect(within(column('Done')).getByRole('article', { name: 'Finished' })).toBeTruthy();
    expect(screen.queryByRole('article', { name: 'Archived' })).toBeNull();
    expect(within(column('Needs you')).getByText('Asked you a question')).toBeTruthy();
    expect(column('Review').querySelector('.count')!.textContent).toBe('1');
  });

  it('shows the empty notes and the Done drop hint', () => {
    mount(seeded([chat({ column: 'running' })]));
    expect(within(column('Needs you')).getByText('Nothing needs you')).toBeTruthy();
    expect(within(column('Review')).getByText('Nothing to review yet')).toBeTruthy();
    expect(within(column('Done')).getByText('Drag a finished chat here')).toBeTruthy();
  });

  it('writes each needs-you reason in plain words, with the limit reset time', () => {
    const reasons = ['permission', 'stopped', 'error', 'interrupted', 'limit'] as const;
    const resetsAt = new Date(NOW + 2 * 3_600_000).toISOString();
    const store = seeded(reasons.map((r, i) => chat({ id: r, title: r, column: 'needs_you', needsReason: r, sessionRef: `s${i}` })), {
      usage: { claude: { provider: 'claude', status: 'ok', readAt: '', windows: [{ kind: 'five_hour', label: '5 hours', leftPct: 0, resetsAt }] } },
    });
    mount(store);
    expect(within(card('permission')).getByText('Wants to run a command')).toBeTruthy();
    expect(within(card('stopped')).getByText('Stopped')).toBeTruthy();
    expect(within(card('error')).getByText('Something went wrong')).toBeTruthy();
    expect(within(card('interrupted')).getByText('Interrupted')).toBeTruthy();
    const badge = within(card('limit')).getByText(/^Out of usage · resets/);
    expect(badge.textContent).toBe(`Out of usage · resets ${clockTime(resetsAt, NOW)}`);
    expect(badge.textContent).toMatch(/resets \d{1,2}:\d{2} (am|pm)$/);
  });

  it('shows the activity line from the latest running tool call, and the last 5 steps under Show more', () => {
    const calls = Array.from({ length: 7 }, (_, i) => tool({ id: `t${i}`, summary: `Step ${i}`, status: 'done' }));
    calls[6] = tool({ id: 't6', summary: 'Editing board.tsx', name: 'Edit', status: 'running' });
    mount(seeded([chat({ column: 'running', title: 'Busy' })], { toolCalls: { c1: calls } }));
    const c = card('Busy');
    expect(c.querySelector('.activity-line .now')!.textContent).toBe('Editing board.tsx');
    fireEvent.click(within(c).getByRole('button', { name: 'Show more' }));
    const items = c.querySelectorAll('.steps li');
    expect([...items].map((li) => li.textContent)).toEqual(['Step 2', 'Step 3', 'Step 4', 'Step 5', 'Editing board.tsx']);
    expect(within(c).getByRole('button', { name: 'Show less' })).toBeTruthy();
  });

  it('shows the step count and how long it took on Review and Done cards', () => {
    mount(seeded([chat({ column: 'review', title: 'Took a while', createdAt: '2026-10-23T09:00:00.000Z', updatedAt: '2026-10-23T09:06:00.000Z' })],
      { toolCalls: { c1: [tool({ id: 'a' }), tool({ id: 'b' })] } }));
    expect(within(card('Took a while')).getByText('2 steps')).toBeTruthy();
    expect(within(card('Took a while')).getByText('6m')).toBeTruthy();
  });

  it('opens a card in the panel on click and on Enter', () => {
    const store = seeded([chat({ title: 'Open me' })]);
    mount(store);
    fireEvent.click(card('Open me'));
    expect(store.getState().ui.openChatId).toBe('c1');
    act(() => store.setState((s) => ({ ...s, ui: { ...s.ui, openChatId: null } })));
    fireEvent.keyDown(card('Open me'), { key: 'Enter' });
    expect(store.getState().ui.openChatId).toBe('c1');
    expect(card('Open me').getAttribute('aria-current')).toBe('true');
  });

  it('opens the row menu from the card "…" button', () => {
    const menu = vi.fn();
    setRowMenuHandler(menu);
    mount(seeded([chat({ title: 'Menu' })]));
    fireEvent.click(within(card('Menu')).getByRole('button', { name: 'More actions' }));
    expect(menu).toHaveBeenCalledWith({ chatId: 'c1', history: null }, expect.any(HTMLElement));
  });
});

describe('Board: movement', () => {
  it('a chat.updated that changes the column moves the same card node through flip, lifted', () => {
    const c = chat({ title: 'Mover', column: 'running' });
    const store = seeded([c, chat({ id: 'other', sessionRef: 's9', title: 'Other', column: 'review' })]);
    mount(store);
    const el = card('Mover');
    act(() => store.setState((s) => applyEvent(s, { type: 'chat.updated', chat: { ...c, column: 'review', updatedAt: '2026-10-23T11:00:00.000Z' } })));
    expect(flip).toHaveBeenCalledTimes(1);
    expect(vi.mocked(flip).mock.calls[0]![2]).toEqual({ lift: el });
    expect(card('Mover')).toBe(el);
    expect(within(column('Review')).getByRole('article', { name: 'Mover' })).toBe(el);
    expect(column('Running').querySelector('.card')).toBeNull();
  });
});

describe('Board: permission badge', () => {
  it('says what the open permission is for (edit / tool), and run a command when unknown', () => {
    const r = (requestId: string, action?: 'edit' | 'tool') => ({ requestId, kind: 'permission' as const, summary: 's', createdAt: '2026-10-23T11:00:00.000Z', ...(action ? { action } : {}) });
    const store = seeded([
      chat({ id: 'e', title: 'Edits', column: 'needs_you', needsReason: 'permission' }),
      chat({ id: 't', title: 'Tools', column: 'needs_you', needsReason: 'permission' }),
      chat({ id: 'u', title: 'Unknown', column: 'needs_you', needsReason: 'permission' }),
    ]);
    act(() => store.setState((s) => ({ ...s, requests: { e: [r('1', 'edit')], t: [r('2', 'tool')], u: [r('3')] } })));
    mount(store);
    expect(within(card('Edits')).getByText('Wants to edit a file')).toBeTruthy();
    expect(within(card('Tools')).getByText('Wants to use a tool')).toBeTruthy();
    expect(within(card('Unknown')).getByText('Wants to run a command')).toBeTruthy();
  });
});

describe('Board: a chat that is still starting', () => {
  it('a new Antigravity chat waiting for its session says the first start can take a couple of minutes; others say Getting started…', () => {
    mount(seeded([
      chat({ id: 'a', title: 'Slow start', provider: 'antigravity', sessionRef: null, column: 'running' }),
      chat({ id: 'b', title: 'Has session', provider: 'antigravity', sessionRef: 's9', column: 'running' }),
      chat({ id: 'c', title: 'Claude start', provider: 'claude', sessionRef: null, column: 'running' }),
    ]));
    expect(within(card('Slow start')).getByText(ANTIGRAVITY_STARTING)).toBeTruthy();
    expect(within(card('Has session')).getByText('Getting started…')).toBeTruthy();
    expect(within(card('Claude start')).getByText('Getting started…')).toBeTruthy();
  });
});

describe('Board: card hover actions and long titles', () => {
  it('hover never changes the title layout: the actions float on a fade, titles clamp at 3 lines, tokens only (#9)', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('src/styles/app.css', 'utf8'); // vitest runs from apps/web
    expect(css).not.toMatch(/:hover \.card-title[^{]*\{[^}]*padding-inline-end/);
    const actions = /\.card-actions \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(actions).toMatch(/background: linear-gradient\(to right, transparent, var\(--color-surface\) var\(--space-6\)\)/);
    expect(actions.replace(/var\(--[\w-]+\)/g, '')).not.toMatch(/\d(px|rem|em)/);
    expect(/\.card-title \{([^}]*)\}/.exec(css)?.[1]).toMatch(/-webkit-line-clamp: 3/);
  });
});

describe('Board: actions', () => {
  it('Stop calls api.stop and applies the returned chat', async () => {
    const c = chat({ title: 'Stoppable' });
    mocked.stop.mockResolvedValue({ ...c, column: 'needs_you', needsReason: 'stopped', updatedAt: '2026-10-23T11:00:00.000Z' });
    const store = seeded([c]);
    mount(store);
    fireEvent.click(within(card('Stoppable')).getByRole('button', { name: 'Stop agent' }));
    expect(mocked.stop).toHaveBeenCalledWith('c1');
    await waitFor(() => expect(store.getState().chats.c1!.column).toBe('needs_you'));
    expect(within(column('Needs you')).getByText('Stopped')).toBeTruthy();
  });

  it('a failed Stop (409) shows the server message and leaves the card as it was', async () => {
    const c = chat({ title: 'Busy elsewhere' });
    mocked.stop.mockRejectedValue(new ApiError('This chat is active in Claude Code. Stop it there.', 409));
    const store = seeded([c]);
    const before = store.getState().chats;
    mount(store);
    fireEvent.click(within(card('Busy elsewhere')).getByRole('button', { name: 'Stop agent' }));
    expect(await screen.findByText('This chat is active in Claude Code. Stop it there.')).toBeTruthy();
    expect(store.getState().chats).toBe(before);
    expect(within(column('Running')).getByRole('article', { name: 'Busy elsewhere' })).toBeTruthy();
    await waitFor(() => expect((within(card('Busy elsewhere')).getByRole('button', { name: 'Stop agent' }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('a 404 shows the server message too', async () => {
    mocked.stop.mockRejectedValue(new ApiError('That chat no longer exists.', 404));
    mount(seeded([chat({ title: 'Gone' })]));
    fireEvent.click(within(card('Gone')).getByRole('button', { name: 'Stop agent' }));
    expect(await screen.findByText('That chat no longer exists.')).toBeTruthy();
    expect(card('Gone')).toBeTruthy();
  });

  it('Resume sends the continue text on stopped and interrupted chats', async () => {
    mocked.send.mockResolvedValue(undefined);
    mount(seeded([
      chat({ id: 'a', title: 'Was stopped', column: 'needs_you', needsReason: 'stopped' }),
      chat({ id: 'b', title: 'Was cut off', column: 'needs_you', needsReason: 'interrupted', sessionRef: 's2' }),
      chat({ id: 'c', title: 'Has a question', column: 'needs_you', needsReason: 'question', sessionRef: 's3' }),
    ]));
    fireEvent.click(within(card('Was stopped')).getByRole('button', { name: 'Resume' }));
    expect(mocked.send).toHaveBeenCalledWith('a', RESUME_TEXT);
    fireEvent.click(within(card('Was cut off')).getByRole('button', { name: 'Resume' }));
    expect(mocked.send).toHaveBeenCalledWith('b', 'Continue where you left off.');
    expect(within(card('Has a question')).queryByRole('button', { name: 'Resume' })).toBeNull();
    await waitFor(() => expect((within(card('Was stopped')).getByRole('button', { name: 'Resume' }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('Mark done (keyboard reachable) calls api.done; Back to Review calls api.undone', async () => {
    const r = chat({ id: 'r', title: 'Reviewed', column: 'review' });
    const d = chat({ id: 'd', title: 'Was done', column: 'done', sessionRef: 's2' });
    mocked.done.mockResolvedValue({ ...r, column: 'done', updatedAt: '2026-10-23T11:00:00.000Z' });
    mocked.undone.mockResolvedValue({ ...d, column: 'review', updatedAt: '2026-10-23T11:00:00.000Z' });
    const store = seeded([r, d]);
    mount(store);
    fireEvent.click(within(card('Reviewed')).getByRole('button', { name: 'Mark done' }));
    expect(mocked.done).toHaveBeenCalledWith('r');
    fireEvent.click(within(card('Was done')).getByRole('button', { name: 'Back to Review' }));
    expect(mocked.undone).toHaveBeenCalledWith('d');
    await waitFor(() => expect(store.getState().chats.r!.column).toBe('done'));
    await waitFor(() => expect(store.getState().chats.d!.column).toBe('review'));
  });
});

describe('Board: drag', () => {
  const realFromPoint = document.elementFromPoint;
  afterEach(() => { document.elementFromPoint = realFromPoint; });

  function drag(el: HTMLElement, over: HTMLElement) {
    document.elementFromPoint = () => over;
    fireEvent.pointerDown(el, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(el, { pointerId: 1, clientX: 200, clientY: 40 });
    fireEvent.pointerUp(el, { pointerId: 1, clientX: 200, clientY: 40 });
    fireEvent.click(el);
  }

  it('dropping on Done calls api.done and does not open the panel', async () => {
    const c = chat({ title: 'Drag me', column: 'review' });
    mocked.done.mockResolvedValue({ ...c, column: 'done', updatedAt: '2026-10-23T11:00:00.000Z' });
    const store = seeded([c]);
    mount(store);
    drag(card('Drag me'), column('Done'));
    expect(mocked.done).toHaveBeenCalledWith('c1');
    expect(store.getState().ui.openChatId).toBeNull();
    await waitFor(() => expect(within(column('Done')).getByRole('article', { name: 'Drag me' })).toBeTruthy());
    expect(card('Drag me').style.transform).toBe('');
    expect(card('Drag me').classList.contains('dragging')).toBe(false);
  });

  it('dropping on Running is refused: the card snaps back and the hint explains why', async () => {
    const store = seeded([chat({ title: 'Stay', column: 'review' })]);
    const before = store.getState().chats;
    mount(store);
    drag(card('Stay'), column('Running'));
    expect(mocked.done).not.toHaveBeenCalled();
    expect(mocked.undone).not.toHaveBeenCalled();
    expect(await screen.findByText(HINT_AGENT_COLUMNS)).toBeTruthy();
    expect(store.getState().chats).toBe(before);
    expect(card('Stay').style.transform).toBe('');
    expect(within(column('Review')).getByRole('article', { name: 'Stay' })).toBeTruthy();
  });

  it('a failed drop to Done shows the server message and the card stays', async () => {
    mocked.done.mockRejectedValue(new ApiError('That chat no longer exists.', 404));
    const store = seeded([chat({ title: 'Nope', column: 'review' })]);
    mount(store);
    drag(card('Nope'), column('Done'));
    expect((await screen.findAllByText('That chat no longer exists.')).length).toBeGreaterThan(0);
    expect(within(column('Review')).getByRole('article', { name: 'Nope' })).toBeTruthy();
    expect(card('Nope').style.transform).toBe('');
  });
});

describe('Board: empty and no results', () => {
  const hist = (n: number): HistoryChat[] => Array.from({ length: n }, (_, i) => ({
    provider: 'codex', sessionRef: `h${i}`, title: `Old chat ${i}`, cwd: '/work/beta', updatedAt: new Date(NOW - (i + 1) * 3_600_000).toISOString(),
  }));

  it('an empty board offers Start a chat and up to 3 recent history chats', () => {
    const newChat = vi.fn();
    const openHistory = vi.fn();
    setNewChatHandler(newChat);
    setHistoryHandler(openHistory);
    mount(seeded([], {}, hist(5)));
    const box = screen.getByRole('region', { name: 'Empty board' });
    expect(within(box).getByText('Nothing on the board yet')).toBeTruthy();
    fireEvent.click(within(box).getByRole('button', { name: /Start a chat/ }));
    expect(newChat).toHaveBeenCalled();
    const recent = box.querySelectorAll('.rc');
    expect(recent.length).toBe(3);
    expect(recent[0]!.textContent).toContain('Old chat 0');
    fireEvent.click(recent[0]!);
    expect(openHistory).toHaveBeenCalledWith({ provider: 'codex', sessionRef: 'h0', cwd: '/work/beta', title: 'Old chat 0' });
  });

  it('is not shown before the first load, and asks to connect an agent when none is connected', () => {
    const { unmount } = mount(createStore({ ...initialState(), now: NOW, history: hist(2) }));
    expect(screen.queryByText('Nothing on the board yet')).toBeNull();
    unmount();
    mount(seeded([], {}, [], [{ ...connected, status: 'not_installed' }]));
    expect(screen.getByText('Connect an agent to get started')).toBeTruthy();
  });

  it('is not shown once a chat is on the board', () => {
    mount(seeded([chat()], {}, hist(2)));
    expect(screen.queryByText('Nothing on the board yet')).toBeNull();
  });

  it('filters that hide every card show the no-results state; Clear filters brings the cards back', () => {
    const base = seeded([chat({ title: 'Claude chat', provider: 'claude' })]);
    const store = createStore({ ...base.getState(), ui: { ...base.getState().ui, filters: { ...base.getState().ui.filters, provider: ['codex'] } } });
    mount(store);
    expect(screen.getByText('No chats match these filters')).toBeTruthy();
    expect(screen.queryByText('Nothing on the board yet')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(store.getState().ui.filters.provider).toBeNull();
    expect(card('Claude chat')).toBeTruthy();
    expect(screen.queryByText('No chats match these filters')).toBeNull();
  });
});

function setReducedMotion(on: boolean) {
  window.matchMedia = ((q: string) => ({ matches: on && q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
}

describe('Board: fix round 1', () => {
  const realFromPoint = document.elementFromPoint;
  const realMatchMedia = window.matchMedia;
  afterEach(() => {
    document.elementFromPoint = realFromPoint;
    window.matchMedia = realMatchMedia;
    vi.useRealTimers();
  });

  function dragTo(el: HTMLElement, over: HTMLElement) {
    document.elementFromPoint = () => over;
    fireEvent.pointerDown(el, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(el, { pointerId: 1, clientX: 200, clientY: 40 });
    fireEvent.pointerUp(el, { pointerId: 1, clientX: 200, clientY: 40 });
  }

  it('a press released outside the card ends the gesture: a later move and click is not a drag', () => {
    const store = seeded([chat({ title: 'Pressed', column: 'review' })]);
    mount(store);
    const el = card('Pressed');
    const toasts = document.querySelectorAll('.toast').length;
    document.elementFromPoint = () => column('Done');
    fireEvent.pointerDown(el, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(document.body, { pointerId: 1, clientX: 400, clientY: 10 });
    fireEvent.pointerMove(el, { pointerId: 2, clientX: 300, clientY: 80 });
    fireEvent.pointerUp(el, { pointerId: 2, clientX: 300, clientY: 80 });
    fireEvent.click(el);
    expect(mocked.done).not.toHaveBeenCalled();
    expect(el.classList.contains('dragging')).toBe(false);
    expect(el.style.transform).toBe('');
    expect(store.getState().ui.openChatId).toBe('c1');
    expect(document.querySelectorAll('.toast').length).toBe(toasts);
  });

  it('a card unmounted mid-drag leaves no listeners behind', () => {
    const c = chat({ title: 'Leaving', column: 'review' });
    const store = seeded([c]);
    mount(store);
    const el = card('Leaving');
    fireEvent.pointerDown(el, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    act(() => store.setState((s) => applyEvent(s, { type: 'chat.updated', chat: { ...c, archived: true, updatedAt: '2026-10-23T11:00:00.000Z' } })));
    const spy = vi.fn();
    document.elementFromPoint = spy;
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 300, clientY: 80 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 300, clientY: 80 });
    expect(spy).not.toHaveBeenCalled();
    expect(mocked.done).not.toHaveBeenCalled();
  });

  it('Escape with focus on a card button reaches the document and closes an open popover', () => {
    function WithPopover() {
      const [open, setOpen] = useState(true);
      const [anchor, setAnchor] = useState<HTMLElement | null>(null);
      return (<><button ref={setAnchor}>anchor</button><Popover anchor={anchor} open={open} onClose={() => setOpen(false)} label="Some popover"><p>inside</p></Popover></>);
    }
    render(<StoreProvider store={seeded([chat({ title: 'Focused' })])}><Board /><WithPopover /></StoreProvider>);
    const btn = within(card('Focused')).getByRole('button', { name: 'Stop agent' });
    btn.focus();
    fireEvent.keyDown(btn, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'Some popover', hidden: true }).getAttribute('data-state')).toBe('closed');
  });

  it('keyboard focus stays on a card when it moves to another column', () => {
    const c = chat({ title: 'Focus me', column: 'running' });
    const store = seeded([c]);
    mount(store);
    const el = card('Focus me');
    el.focus();
    expect(document.activeElement).toBe(el);
    act(() => store.setState((s) => applyEvent(s, { type: 'chat.updated', chat: { ...c, column: 'review', updatedAt: '2026-10-23T11:00:00.000Z' } })));
    expect(within(column('Review')).getByRole('article', { name: 'Focus me' })).toBe(el);
    expect(document.activeElement).toBe(el);
  });

  it('the arrival tint is dropped once its animation has played', () => {
    vi.useFakeTimers({ now: Date.now() });
    const store = seeded([chat({ id: 'old', title: 'Old', sessionRef: 'o' })]);
    mount(store);
    const at = new Date().toISOString();
    act(() => store.setState((s) => applyEvent(s, { type: 'chat.updated', chat: chat({ id: 'new', title: 'Brand new', sessionRef: 'n', createdAt: at, updatedAt: at }) })));
    const el = card('Brand new');
    expect(el.classList.contains('new')).toBe(true);
    act(() => { vi.advanceTimersByTime(700); });
    expect(el.classList.contains('new')).toBe(false);
  });

  it('a second arrival does not cut the first card\'s tint short', () => {
    vi.useFakeTimers({ now: Date.now() });
    const store = seeded([chat({ id: 'old', title: 'Old', sessionRef: 'o' })]);
    mount(store);
    const arrive = (id: string, title: string) => {
      const at = new Date().toISOString();
      act(() => store.setState((s) => applyEvent(s, { type: 'chat.updated', chat: chat({ id, title, sessionRef: id, createdAt: at, updatedAt: at }) })));
    };
    arrive('n1', 'First new');
    act(() => { vi.advanceTimersByTime(100); });
    arrive('n2', 'Second new');
    expect(card('First new').classList.contains('new')).toBe(true);
    expect(card('Second new').classList.contains('new')).toBe(true);
  });

  it('running cards offer Mark done too (keyboard path for running to Done)', () => {
    mocked.done.mockResolvedValue(undefined);
    mount(seeded([chat({ title: 'Still going' })]));
    fireEvent.click(within(card('Still going')).getByRole('button', { name: 'Mark done' }));
    expect(mocked.done).toHaveBeenCalledWith('c1');
  });

  it('dragging a Done card to Review calls api.undone', async () => {
    const c = chat({ title: 'Reopen', column: 'done' });
    mocked.undone.mockResolvedValue({ ...c, column: 'review', updatedAt: '2026-10-23T11:00:00.000Z' });
    mount(seeded([c]));
    dragTo(card('Reopen'), column('Review'));
    expect(mocked.undone).toHaveBeenCalledWith('c1');
    await waitFor(() => expect(within(column('Review')).getByRole('article', { name: 'Reopen' })).toBeTruthy());
  });

  it('dragging a Done card to Running is refused with the Done hint', async () => {
    mount(seeded([chat({ title: 'Finished one', column: 'done' })]));
    dragTo(card('Finished one'), column('Running'));
    expect(mocked.undone).not.toHaveBeenCalled();
    expect(mocked.done).not.toHaveBeenCalled();
    expect(await screen.findByText(HINT_DONE_BACK)).toBeTruthy();
  });

  it('a refused drop animates back, except with reduced motion', () => {
    mount(seeded([chat({ id: 'a', title: 'Bouncy', column: 'review' }), chat({ id: 'b', title: 'Calm', column: 'review', sessionRef: 's2' })]));
    const bouncy = card('Bouncy');
    const calm = card('Calm');
    bouncy.animate = vi.fn() as unknown as HTMLElement['animate'];
    calm.animate = vi.fn() as unknown as HTMLElement['animate'];
    setReducedMotion(false);
    dragTo(bouncy, column('Running'));
    expect(bouncy.animate).toHaveBeenCalledTimes(1);
    setReducedMotion(true);
    dragTo(calm, column('Running'));
    expect(calm.animate).not.toHaveBeenCalled();
    expect(calm.style.transform).toBe('');
  });

  it('the activity line crossfades to a new step, or swaps at once with reduced motion', () => {
    vi.useFakeTimers();
    setReducedMotion(false);
    const store = seeded([chat({ title: 'Working' })], { toolCalls: { c1: [tool({ id: 'a', summary: 'First step', status: 'running' })] } });
    mount(store);
    const now = () => card('Working').querySelector('.activity-line .now')!;
    act(() => store.setState((s) => applyEvent(s, { type: 'tool.call', chatId: 'c1', toolCall: tool({ id: 'b', summary: 'Second step', status: 'running' }) })));
    expect(now().textContent).toBe('First step');
    expect(now().classList.contains('out')).toBe(true);
    act(() => { vi.advanceTimersByTime(250); });
    expect(now().textContent).toBe('Second step');
    expect(now().className).toBe('now');
    setReducedMotion(true);
    act(() => store.setState((s) => applyEvent(s, { type: 'tool.call', chatId: 'c1', toolCall: tool({ id: 'c', summary: 'Third step', status: 'running' }) })));
    expect(now().textContent).toBe('Third step');
    expect(now().className).toBe('now');
  });
});

describe('dateTime (#23)', () => {
  it('says Today for today, the month and day otherwise, and the year only for another year', async () => {
    const { dateTime } = await import('../src/ui/board/format.ts');
    const now = new Date('2026-10-30T12:00:00').getTime();
    expect(dateTime(new Date('2026-10-30T08:15:00').toISOString(), now)).toBe('Today, 8:15 am');
    expect(dateTime(new Date('2026-10-27T15:01:00').toISOString(), now)).toBe('Oct 27, 3:01 pm');
    expect(dateTime(new Date('2025-12-31T23:59:00').toISOString(), now)).toBe('Dec 31, 2025, 11:59 pm');
    expect(dateTime('not a date', now)).toBe('');
  });
});
