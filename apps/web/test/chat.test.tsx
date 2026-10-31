import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Chat, HistoryChat, Message, OpenRequest, ToolCall } from '@agent-kanban/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/api/client.ts';
import { applyEvent, applySnapshot, initialState, type AppState } from '../src/state/reducer.ts';
import { createStore, StoreProvider, type Store } from '../src/state/store.ts';
import { openHistoryChat, openRowMenu } from '../src/ui/actions.ts';
import { Board } from '../src/ui/board/Board.tsx';
import { ChatPanel } from '../src/ui/chat/ChatPanel.tsx';
import { resumeCommand, snoozeOptions } from '../src/ui/chat/ChatActionsMenu.tsx';
import { buildTurns } from '../src/ui/chat/Thread.tsx';
import { Toasts } from '../src/ui/primitives/toast.tsx';
import { Dialog } from '../src/ui/primitives/Dialog.tsx';
import { chat, message } from './helpers.ts';

const FNS = ['listMessages', 'listRequests', 'listToolCalls', 'send', 'answer', 'stop', 'done', 'archive', 'patchChat', 'continueHistory', 'historyMessages', 'openFolder'] as const;
type Fn = (typeof FNS)[number];

vi.mock('../src/api/client.ts', async (orig) => {
  const m = await orig<typeof import('../src/api/client.ts')>();
  const fns = Object.fromEntries(['listMessages', 'listRequests', 'listToolCalls', 'send', 'answer', 'stop', 'done', 'archive', 'patchChat', 'continueHistory', 'historyMessages', 'openFolder'].map((k) => [k, vi.fn()]));
  return { ...m, api: { ...m.api, ...fns } };
});

const mocked = api as unknown as Record<Fn, ReturnType<typeof vi.fn>>;
const NOW = Date.parse('2026-10-23T12:00:00.000Z');

function seeded(chats: Chat[], extra: Partial<AppState> = {}, history: HistoryChat[] = []): Store {
  const s = applySnapshot(initialState(), { chats, usage: [], suggested: null, connections: [], history, projects: [] });
  return createStore({ ...s, now: NOW, ...extra });
}
const mount = (store: Store) => render(<StoreProvider store={store}><Board /><ChatPanel /><Toasts /></StoreProvider>);
const card = (title: string) => screen.getByRole('article', { name: title });
const panel = () => document.querySelector<HTMLElement>('aside.panel')!;
/** jsdom keeps `inert` as a plain property (no attribute), so walk up checking both. */
const inertUp = (el: Element | null): boolean => {
  for (let n = el; n; n = n.parentElement) if ((n as HTMLElement).inert || n.hasAttribute('inert')) return true;
  return false;
};
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const req = (over: Partial<OpenRequest> = {}): OpenRequest => ({ requestId: 'r1', kind: 'permission', summary: 'npm run build', createdAt: '2026-10-23T11:00:00.000Z', ...over });
const tool = (over: Partial<ToolCall>): ToolCall => ({ id: 't', chatId: 'c1', name: 'Bash', summary: 'Running npm test', status: 'done', createdAt: '2026-10-23T11:00:00.000Z', ...over });

function thread(messages: Message[] = [], requests: OpenRequest[] = [], calls: ToolCall[] = []) {
  mocked.listMessages.mockResolvedValue(messages);
  mocked.listRequests.mockResolvedValue(requests);
  mocked.listToolCalls.mockResolvedValue(calls);
}

beforeEach(() => {
  for (const k of FNS) mocked[k].mockReset();
  mocked.historyMessages.mockResolvedValue({ messages: [], truncated: false, unavailable: true });
  thread();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Chat panel: opening and loading', () => {
  it('opening a card loads its messages, requests and tool calls once', async () => {
    thread([message({ id: 'u1', role: 'user', text: 'Fix the build', createdAt: '2026-10-23T10:00:00.000Z' }), message({ id: 'a1', text: 'Fixed it.', createdAt: '2026-10-23T10:05:00.000Z' })],
      [], [tool({ id: 't1', summary: 'Running npm test', createdAt: '2026-10-23T10:01:00.000Z' })]);
    const store = seeded([chat({ title: 'Build', column: 'review' })]);
    mount(store);
    expect(panel().dataset.state).toBe('closed');
    fireEvent.click(card('Build'));
    expect(panel().dataset.state).toBe('open');
    await waitFor(() => expect(within(panel()).getByText('Fixed it.')).toBeTruthy());
    expect(within(panel()).getByText('Fix the build')).toBeTruthy();
    expect(within(panel()).getByText('Worked · 1 step')).toBeTruthy();
    expect(within(panel()).getByText('Same chat as in Claude Code')).toBeTruthy();
    expect(mocked.listMessages).toHaveBeenCalledTimes(1);
    expect(mocked.listRequests).toHaveBeenCalledTimes(1);
    expect(mocked.listToolCalls).toHaveBeenCalledTimes(1);

    // Events, closing and opening again never refetch a loaded chat.
    act(() => store.setState((s) => applyEvent(s, { type: 'chat.updated', chat: { ...s.chats.c1!, title: 'Build 2', updatedAt: '2026-10-23T11:30:00.000Z' } })));
    fireEvent.click(within(panel()).getByRole('button', { name: 'Close panel' }));
    expect(panel().dataset.state).toBe('closed');
    fireEvent.click(card('Build 2'));
    await flush();
    expect(mocked.listMessages).toHaveBeenCalledTimes(1);
  });

  it('streams message deltas into the open thread', async () => {
    const store = seeded([chat({ title: 'Live' })]);
    mount(store);
    fireEvent.click(card('Live'));
    await flush();
    act(() => store.setState((s) => applyEvent(s, { type: 'message.delta', chatId: 'c1', messageId: 'a1', text: 'Hel', offset: 0 })));
    expect(within(panel()).getByText('Hel')).toBeTruthy();
    act(() => store.setState((s) => applyEvent(s, { type: 'message.delta', chatId: 'c1', messageId: 'a1', text: 'lo there', offset: 3 })));
    expect(within(panel()).getByText('Hello there')).toBeTruthy();
    act(() => store.setState((s) => applyEvent(s, { type: 'message.completed', chatId: 'c1', message: message({ id: 'a1', text: 'Hello there!', createdAt: '2026-10-23T11:59:00.000Z' }) })));
    expect(within(panel()).getByText('Hello there!', { selector: '.msg-text, .msg-text .md-p' })).toBeTruthy();
    expect(within(panel()).queryByText('Hello there', { selector: '.msg-text, .msg-text .md-p' })).toBeNull();
  });

  it('announces a completed reply once, not each streamed piece', async () => {
    thread([message({ id: 'a0', text: 'Earlier reply' })]);
    const store = seeded([chat({ title: 'Speak' })]);
    mount(store);
    fireEvent.click(card('Speak'));
    await waitFor(() => expect(within(panel()).getByText('Earlier reply')).toBeTruthy());
    const live = panel().querySelector('.sr-only[aria-live="polite"]')!;
    expect(live.textContent).toBe('');
    expect(panel().querySelector('.thread')!.getAttribute('role')).toBe('log');
    act(() => store.setState((s) => applyEvent(s, { type: 'message.delta', chatId: 'c1', messageId: 'a1', text: 'Hi ', offset: 0 })));
    expect(live.textContent).toBe('');
    act(() => store.setState((s) => applyEvent(s, { type: 'message.completed', chatId: 'c1', message: message({ id: 'a1', text: 'Hi there', createdAt: '2026-10-23T11:59:00.000Z' }) })));
    expect(live.textContent).toBe('Hi there');
  });

  it('a dialog opened over the panel makes the panel inert and takes the first Escape', () => {
    const store = seeded([chat({ title: 'Under' })]);
    const onClose = vi.fn();
    const ui = (open: boolean) => (
      <StoreProvider store={store}><Board /><ChatPanel /><Toasts /><Dialog open={open} onClose={onClose} title="New chat">body</Dialog></StoreProvider>
    );
    const view = render(ui(false));
    fireEvent.click(card('Under'));
    expect(inertUp(panel())).toBe(false);
    view.rerender(ui(true));
    expect(inertUp(panel())).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(store.getState().ui.openChatId).toBe('c1');
    view.rerender(ui(false));
    expect(inertUp(panel())).toBe(false);
  });

  it('Escape while an IME is composing does not close the panel', () => {
    const store = seeded([chat({ title: 'Ime' })]);
    mount(store);
    fireEvent.click(card('Ime'));
    fireEvent.keyDown(document, { key: 'Escape', isComposing: true });
    expect(store.getState().ui.openChatId).toBe('c1');
  });

  it('a new tool call keeps a thread that is at the bottom scrolled to the bottom', async () => {
    thread([message({ id: 'u1', role: 'user', text: 'Go' })], [], [tool({ id: 't1', status: 'running' })]);
    const store = seeded([chat({ title: 'Follow' })]);
    mount(store);
    fireEvent.click(card('Follow'));
    await waitFor(() => expect(within(panel()).getByText('Working · 1 step')).toBeTruthy());
    const el = panel().querySelector<HTMLElement>('.thread')!;
    let height = 1000;
    let top = 0;
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => height });
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 300 });
    Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => { top = v; } });
    top = 700;
    fireEvent.scroll(el);
    height = 1400;
    act(() => store.setState((s) => applyEvent(s, { type: 'tool.call', chatId: 'c1', toolCall: tool({ id: 't2', summary: 'Reading a file', status: 'running', createdAt: '2026-10-23T11:30:00.000Z' }) })));
    expect(within(panel()).getByText('Working · 2 steps')).toBeTruthy();
    expect(top).toBe(1400);
  });

  it('the panel is named by the chat title outside rename mode, and by the title field while renaming', async () => {
    mount(seeded([chat({ title: 'Named chat', column: 'review' })]));
    fireEvent.click(card('Named chat'));
    expect(screen.getByRole('complementary', { name: 'Named chat' })).toBe(panel());
    expect(document.querySelectorAll('#panel-title')).toHaveLength(1);
    fireEvent.click(within(panel()).getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    expect(document.querySelectorAll('#panel-title')).toHaveLength(1);
    expect(document.getElementById('panel-title')!.tagName).toBe('INPUT');
    fireEvent.keyDown(within(panel()).getByRole('textbox', { name: 'Chat title' }), { key: 'Escape' });
    expect(document.getElementById('panel-title')!.textContent).toBe('Named chat');
  });

  it('renders the latest 200 of 2 000 messages until Show earlier', async () => {
    const many = Array.from({ length: 2000 }, (_, i) => message({
      id: `m${i}`, role: i % 2 === 0 ? 'user' : 'assistant', text: `Message ${i}`,
      createdAt: new Date(Date.parse('2026-10-20T00:00:00.000Z') + i * 1000).toISOString(),
    }));
    thread(many);
    mount(seeded([chat({ title: 'Long', column: 'review' })]));
    fireEvent.click(card('Long'));
    await waitFor(() => expect(within(panel()).getByText('Message 1999')).toBeTruthy());
    expect(panel().querySelectorAll('.msg-text')).toHaveLength(200);
    expect(within(panel()).queryByText('Message 1799')).toBeNull();
    fireEvent.click(within(panel()).getByRole('button', { name: 'Show earlier (1800 more)' }));
    expect(panel().querySelectorAll('.msg-text')).toHaveLength(400);
    expect(within(panel()).getByText('Message 1600')).toBeTruthy();
  });

  it('Escape and a click on the board close the panel; focus moves in and back', async () => {
    const store = seeded([chat({ title: 'Focus' })]);
    mount(store);
    const c = card('Focus');
    c.focus();
    fireEvent.click(c);
    expect(document.activeElement).toBe(within(panel()).getByRole('textbox', { name: 'Message' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(store.getState().ui.openChatId).toBeNull();
    expect(document.activeElement).toBe(c);
    fireEvent.click(c);
    expect(store.getState().ui.openChatId).toBe('c1');
    fireEvent.click(screen.getByRole('region', { name: 'Board' }));
    expect(store.getState().ui.openChatId).toBeNull();
  });
});

describe('Chat panel: permission copy', () => {
  it('a file edit reads "wants to edit a file", another tool "wants to use a tool"', async () => {
    thread([], [req({ action: 'edit', summary: 'Edit a.txt' }), req({ requestId: 'r2', action: 'tool', summary: 'Fetch a page' })]);
    mount(seeded([chat({ title: 'Asks', column: 'needs_you', needsReason: 'permission' })]));
    fireEvent.click(card('Asks'));
    await waitFor(() => expect(within(panel()).getByText('Edit a.txt')).toBeTruthy());
    expect(within(panel()).getByText('Claude Code wants to edit a file')).toBeTruthy();
    expect(within(panel()).getByText('Claude Code wants to use a tool')).toBeTruthy();
  });
});

describe('Chat panel: requests and composer', () => {
  it('Allow answers the permission; the card disappears on the following chat.updated', async () => {
    thread([], [req()]);
    const store = seeded([chat({ title: 'Asks', column: 'needs_you', needsReason: 'permission' })]);
    mocked.answer.mockResolvedValue(undefined);
    mount(store);
    fireEvent.click(card('Asks'));
    await waitFor(() => expect(within(panel()).getByText('npm run build')).toBeTruthy());
    expect(within(panel()).getByText('Claude Code wants to run a command')).toBeTruthy();
    fireEvent.click(within(panel()).getByRole('button', { name: 'Allow' }));
    expect(mocked.answer).toHaveBeenCalledWith('c1', 'r1', 'allow');
    await flush();
    expect(within(panel()).getByText('npm run build')).toBeTruthy();
    act(() => store.setState((s) => applyEvent(s, { type: 'chat.updated', chat: { ...s.chats.c1!, column: 'running', needsReason: null, updatedAt: '2026-10-23T12:01:00.000Z' } })));
    expect(within(panel()).queryByText('npm run build')).toBeNull();
  });

  it('a question is answered with { reply }', async () => {
    thread([], [req({ requestId: 'q1', kind: 'question', summary: 'Which port?' })]);
    mocked.answer.mockResolvedValue(undefined);
    mount(seeded([chat({ title: 'Question', column: 'needs_you', needsReason: 'question' })]));
    fireEvent.click(card('Question'));
    await waitFor(() => expect(within(panel()).getByText('Which port?')).toBeTruthy());
    fireEvent.change(within(panel()).getByRole('textbox', { name: 'Reply' }), { target: { value: '3005' } });
    fireEvent.keyDown(within(panel()).getByRole('textbox', { name: 'Reply' }), { key: 'Enter' });
    expect(mocked.answer).toHaveBeenCalledWith('c1', 'q1', { reply: '3005' });
  });

  it('request.closed while the chat stays in Needs you removes the card and keeps the panel open', async () => {
    thread([], [req(), req({ requestId: 'r2', summary: 'rm -rf build' })]);
    const store = seeded([chat({ title: 'Two asks', column: 'needs_you', needsReason: 'permission' })]);
    mount(store);
    fireEvent.click(card('Two asks'));
    await waitFor(() => expect(within(panel()).getByText('npm run build')).toBeTruthy());
    act(() => store.setState((s) => applyEvent(s, { type: 'request.closed', chatId: 'c1', requestId: 'r1' })));
    expect(within(panel()).queryByText('npm run build')).toBeNull();
    expect(within(panel()).getByText('rm -rf build')).toBeTruthy();
    expect(panel().dataset.state).toBe('open');
    expect(store.getState().ui.openChatId).toBe('c1');
  });

  it('a failed answer shows the server text and keeps the request', async () => {
    thread([], [req()]);
    mocked.answer.mockRejectedValue(new ApiError('That request was already answered.', 409));
    mount(seeded([chat({ title: 'Fails', column: 'needs_you', needsReason: 'permission' })]));
    fireEvent.click(card('Fails'));
    await waitFor(() => expect(within(panel()).getByRole('button', { name: 'Allow' })).toBeTruthy());
    fireEvent.click(within(panel()).getByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(screen.getByText('That request was already answered.')).toBeTruthy());
    expect((within(panel()).getByRole('button', { name: 'Allow' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('Enter sends, Shift+Enter does not; a failed send keeps the text', async () => {
    mocked.send.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new ApiError('Chat not found.', 404));
    mount(seeded([chat({ title: 'Talk', column: 'review' })]));
    fireEvent.click(card('Talk'));
    const box = within(panel()).getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'say hi' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 229 });
    expect(mocked.send).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(mocked.send).toHaveBeenCalledWith('c1', 'say hi');
    await waitFor(() => expect(box.value).toBe(''));
    fireEvent.change(box, { target: { value: 'again' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(screen.getByText('Chat not found.')).toBeTruthy());
    expect(box.value).toBe('again');
  });

  it('header shows Stop while running and Mark done in Review', async () => {
    mocked.stop.mockResolvedValue(chat({ column: 'needs_you', needsReason: 'stopped', updatedAt: '2026-10-23T12:01:00.000Z' }));
    const store = seeded([chat({ title: 'Head', column: 'running' })]);
    mount(store);
    fireEvent.click(card('Head'));
    fireEvent.click(within(panel()).getByRole('button', { name: 'Stop' }));
    expect(mocked.stop).toHaveBeenCalledWith('c1');
    await waitFor(() => expect(within(panel()).getByRole('button', { name: 'Resume' })).toBeTruthy());
    expect(within(panel()).getByText(/You stopped the agent/)).toBeTruthy();
  });
});

describe('Chat panel: actions menu', () => {
  it('rename and pin call patchChat', async () => {
    mocked.patchChat.mockImplementation(async (_id: string, p: Partial<Chat>) => chat({ title: 'Panel', ...p, updatedAt: '2026-10-23T12:01:00.000Z' }));
    const store = seeded([chat({ title: 'Panel', column: 'review' })]);
    mount(store);
    fireEvent.click(card('Panel'));
    fireEvent.click(within(panel()).getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const input = within(panel()).getByRole('textbox', { name: 'Chat title' });
    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(mocked.patchChat).toHaveBeenCalledWith('c1', { title: 'Renamed' });
    await waitFor(() => expect(store.getState().chats.c1!.title).toBe('Renamed'));

    fireEvent.click(within(panel()).getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pin to sidebar' }));
    expect(mocked.patchChat).toHaveBeenLastCalledWith('c1', { pinned: true });
    await waitFor(() => expect(screen.getByText('Pinned to the sidebar')).toBeTruthy());
  });

  it('archive hides the card at once, calls the server only when the Undo toast expires, and Undo cancels it', async () => {
    vi.useFakeTimers();
    mocked.archive.mockResolvedValue(chat({ title: 'Old', column: 'review', archived: true, updatedAt: '2026-10-23T12:01:00.000Z' }));
    const store = seeded([chat({ title: 'Old', column: 'review' })]);
    mount(store);
    act(() => openRowMenu({ chatId: 'c1', history: null }, within(card('Old')).getByRole('button', { name: 'More actions' })));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive chat' }));
    expect(screen.queryByRole('article', { name: 'Old' })).toBeNull();
    act(() => { vi.advanceTimersByTime(4000); });
    expect(mocked.archive).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(card('Old')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(mocked.archive).not.toHaveBeenCalled();

    // Again, and this time let the toast run out.
    act(() => openRowMenu({ chatId: 'c1', history: null }, within(card('Old')).getByRole('button', { name: 'More actions' })));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive chat' }));
    act(() => { vi.advanceTimersByTime(5000); });
    expect(mocked.archive).toHaveBeenCalledTimes(1);
    expect(mocked.archive).toHaveBeenCalledWith('c1', {});
    await act(async () => { await Promise.resolve(); });
    expect(store.getState().chats.c1!.archived).toBe(true);
    expect(store.getState().ui.archiving).toEqual({});
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.queryByText('Chat archived')).toBeNull();
  });

  const pagehide = (persisted: boolean) => window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted }));
  const archiveFromMenu = (title: string) => {
    act(() => openRowMenu({ chatId: 'c1', history: null }, within(card(title)).getByRole('button', { name: 'More actions' })));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive chat' }));
  };

  it('closing the page during the Undo window sends the archive once, with keepalive', async () => {
    vi.useFakeTimers();
    mocked.archive.mockResolvedValue(chat({ title: 'Bye', column: 'review', archived: true, updatedAt: '2026-10-23T12:01:00.000Z' }));
    mount(seeded([chat({ title: 'Bye', column: 'review' })]));
    archiveFromMenu('Bye');
    act(() => { vi.advanceTimersByTime(1000); });
    act(() => { pagehide(false); });
    expect(mocked.archive).toHaveBeenCalledTimes(1);
    expect(mocked.archive).toHaveBeenCalledWith('c1', { keepalive: true });
    // If the page survives anyway, its Undo is already dead: the toast is gone.
    expect(screen.queryByText('Chat archived')).toBeNull();
    act(() => { pagehide(false); });
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(mocked.archive).toHaveBeenCalledTimes(1);
    await act(async () => { await Promise.resolve(); });
  });

  it('a page kept in the back/forward cache drops the Undo toast of an archive it sent', () => {
    vi.useFakeTimers();
    mocked.archive.mockResolvedValue(chat({ title: 'Cached', column: 'review', archived: true }));
    mount(seeded([chat({ title: 'Cached', column: 'review' })]));
    archiveFromMenu('Cached');
    act(() => { pagehide(true); });
    expect(mocked.archive).toHaveBeenCalledWith('c1', { keepalive: true });
    expect(screen.queryByText('Chat archived')).toBeNull();
  });

  it('Undo, then closing the page, sends nothing', () => {
    vi.useFakeTimers();
    mount(seeded([chat({ title: 'Stay', column: 'review' })]));
    archiveFromMenu('Stay');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    act(() => { pagehide(false); });
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(mocked.archive).not.toHaveBeenCalled();
    expect(card('Stay')).toBeTruthy();
  });

  it('a failed archive brings the card back with the server text', async () => {
    vi.useFakeTimers();
    mocked.archive.mockRejectedValue(new ApiError('That chat is gone.', 404));
    const store = seeded([chat({ title: 'Keep', column: 'review' })]);
    mount(store);
    act(() => openRowMenu({ chatId: 'c1', history: null }, within(card('Keep')).getByRole('button', { name: 'More actions' })));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive chat' }));
    act(() => { vi.advanceTimersByTime(5000); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(card('Keep')).toBeTruthy();
    expect(screen.getByText('That chat is gone.')).toBeTruthy();
  });

  it('copies the project path and the resume command', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    mount(seeded([chat({ title: 'Copy', column: 'review', cwd: '/work/alpha', sessionRef: 'abc' })]));
    act(() => openRowMenu({ chatId: 'c1', history: null }, within(card('Copy')).getByRole('button', { name: 'More actions' })));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy resume command' }));
    expect(writeText).toHaveBeenCalledWith('claude --resume abc');
    await waitFor(() => expect(screen.getByText('Copied')).toBeTruthy());
    act(() => openRowMenu({ chatId: 'c1', history: null }, within(card('Copy')).getByRole('button', { name: 'More actions' })));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy project path' }));
    expect(writeText).toHaveBeenLastCalledWith('/work/alpha');
    expect(resumeCommand('codex', 'x')).toBe('codex resume x');
    expect(resumeCommand('antigravity', 'x')).toBeNull();
  });

  it('Open folder shows the project in the file manager; a failure says why', async () => {
    mocked.openFolder.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new ApiError('That folder isn’t there any more. It may have been moved or deleted.', 404));
    mount(seeded([chat({ title: 'Files', column: 'review', cwd: '/work/alpha' })]));
    act(() => openRowMenu({ chatId: 'c1', history: null }, within(card('Files')).getByRole('button', { name: 'More actions' })));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open folder' }));
    expect(mocked.openFolder).toHaveBeenCalledWith('/work/alpha');
    act(() => openRowMenu({ chatId: 'c1', history: null }, within(card('Files')).getByRole('button', { name: 'More actions' })));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open folder' }));
    await waitFor(() => expect(screen.getByText('That folder isn’t there any more. It may have been moved or deleted.')).toBeTruthy());
  });

  it('Mark done is offered for board chats not in Done', () => {
    mocked.done.mockResolvedValue(chat({ column: 'done' }));
    mount(seeded([chat({ title: 'Finish', column: 'review' }), chat({ id: 'd', sessionRef: 's9', title: 'Finished', column: 'done' })]));
    act(() => openRowMenu({ chatId: 'd', history: null }, within(card('Finished')).getByRole('button', { name: 'More actions' })));
    expect(screen.queryByRole('menuitem', { name: 'Mark done' })).toBeNull();
    act(() => openRowMenu({ chatId: 'c1', history: null }, within(card('Finish')).getByRole('button', { name: 'More actions' })));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mark done' }));
    expect(mocked.done).toHaveBeenCalledWith('c1');
  });

  it('snooze options use local time; "This evening" is left out after 18:00', () => {
    const morning = snoozeOptions(new Date(2026, 9, 23, 10, 0));
    expect(morning.map((o) => o.label)).toEqual(['In 1 hour', 'This evening', 'Tomorrow morning', 'Next Monday']);
    expect(morning[1]!.until.getHours()).toBe(18);
    expect(morning[2]!.until.getDate()).toBe(24);
    expect(morning[2]!.until.getHours()).toBe(9);
    // 2026-10-23 is a Friday: next Monday is the 26th.
    expect(morning[3]!.until.getDate()).toBe(26);
    const late = snoozeOptions(new Date(2026, 9, 23, 19, 0));
    expect(late.map((o) => o.label)).toEqual(['In 1 hour', 'Tomorrow morning', 'Next Monday']);
    const monday = snoozeOptions(new Date(2026, 9, 26, 8, 0));
    expect(monday[3]!.until.getDate()).toBe(2);
  });

  it('snooze sends snoozedUntil', async () => {
    vi.useFakeTimers({ now: new Date(2026, 9, 23, 10, 0) });
    mocked.patchChat.mockResolvedValue(chat({ title: 'Later', column: 'review', snoozedUntil: new Date(2026, 9, 23, 18, 0).toISOString() }));
    mount(seeded([chat({ title: 'Later', column: 'review' })]));
    act(() => openRowMenu({ chatId: 'c1', history: null }, within(card('Later')).getByRole('button', { name: 'More actions' })));
    fireEvent.click(screen.getByRole('menuitem', { name: /Snooze/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /This evening/ }));
    expect(mocked.patchChat).toHaveBeenCalledWith('c1', { snoozedUntil: new Date(2026, 9, 23, 18, 0).toISOString() });
  });
});

describe('Chat panel: history-only chats', () => {
  const ref = { provider: 'claude' as const, sessionRef: 'hist-1', cwd: '/work/beta', title: 'Old idea' };

  it("shows the chat's past messages read-only: user text plain, replies as markdown (#16)", async () => {
    mocked.historyMessages.mockResolvedValue({ truncated: true, unavailable: false, messages: [
      { role: 'user', text: 'Fix **the** bug', at: '2026-10-23T09:00:00.000Z' },
      { role: 'assistant', text: 'Fixed in `login.ts`.', at: '2026-10-23T09:01:00.000Z' },
    ] });
    mount(seeded([]));
    act(() => openHistoryChat(ref));
    expect(within(panel()).getByText('Loading earlier messages…')).toBeTruthy();
    await waitFor(() => expect(within(panel()).getByText('Fix **the** bug')).toBeTruthy());
    expect(mocked.historyMessages).toHaveBeenCalledWith('claude', 'hist-1');
    expect(panel().querySelector('.msg.agent code')?.textContent).toBe('login.ts');
    expect(within(panel()).getByText('Showing the last 2 messages. The rest are in Claude Code.')).toBeTruthy();
    expect(within(panel()).getByPlaceholderText('Continue this Claude Code chat')).toBeTruthy();
  });

  it("when the history can't be read (Antigravity, or an error) it says the messages are in the app", async () => {
    mocked.historyMessages.mockResolvedValueOnce({ truncated: false, unavailable: true, messages: [] });
    mount(seeded([]));
    act(() => openHistoryChat({ ...ref, provider: 'antigravity' }));
    await waitFor(() => expect(within(panel()).getByText('Earlier messages are in Antigravity. Send a message to carry on here.')).toBeTruthy());
    cleanup();
    mocked.historyMessages.mockRejectedValueOnce(new Error('boom'));
    mount(seeded([]));
    act(() => openHistoryChat({ ...ref, sessionRef: 'hist-2' }));
    await waitFor(() => expect(within(panel()).getByText('Earlier messages are in Claude Code. Send a message to carry on here.')).toBeTruthy());
  });

  it('opens with "Continue this Claude Code chat"; a 409 shows the server text and keeps the text', async () => {
    mocked.continueHistory.mockRejectedValue(new ApiError('This chat is active in Claude Code. Close it there first.', 409));
    const store = seeded([]);
    mount(store);
    act(() => openHistoryChat(ref));
    expect(store.getState().ui.openHistory).toEqual(ref);
    expect(panel().dataset.state).toBe('open');
    expect(within(panel()).getByText('Old idea')).toBeTruthy();
    const box = within(panel()).getByPlaceholderText('Continue this Claude Code chat') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'carry on' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(mocked.continueHistory).toHaveBeenCalledWith({ provider: 'claude', sessionRef: 'hist-1', text: 'carry on' });
    await waitFor(() => expect(screen.getByText('This chat is active in Claude Code. Close it there first.')).toBeTruthy());
    expect(box.value).toBe('carry on');
    expect(store.getState().ui.openHistory).toEqual(ref);
  });

  it('switching from a board chat to a history chat replaces the thread', async () => {
    thread([message({ id: 'a1', text: 'Board reply' })]);
    const store = seeded([chat({ title: 'Board one', column: 'review' })]);
    mount(store);
    fireEvent.click(card('Board one'));
    await waitFor(() => expect(within(panel()).getByText('Board reply')).toBeTruthy());
    act(() => openHistoryChat(ref));
    expect(panel().querySelectorAll('.thread')).toHaveLength(1);
    expect(within(panel()).queryByText('Board reply')).toBeNull();
    expect(store.getState().ui.openChatId).toBeNull();
  });

  it('continuing switches the panel to the new board chat', async () => {
    const created = chat({ id: 'new', sessionRef: 'hist-1', title: 'Old idea', cwd: '/work/beta', column: 'running' });
    mocked.continueHistory.mockResolvedValue(created);
    const store = seeded([]);
    mount(store);
    act(() => openHistoryChat(ref));
    const box = within(panel()).getByPlaceholderText('Continue this Claude Code chat');
    fireEvent.change(box, { target: { value: 'carry on' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(store.getState().ui.openChatId).toBe('new'));
    expect(store.getState().ui.openHistory).toBeNull();
    // The composer was swapped for the new chat's; focus follows into it.
    expect(document.activeElement).toBe(within(panel()).getByRole('textbox', { name: 'Message' }));
    expect(mocked.listMessages).toHaveBeenCalledWith('new');
  });

  it('the history row menu offers Continue here and the copy items only', () => {
    const store = seeded([]);
    mount(store);
    const anchor = document.body.appendChild(document.createElement('button'));
    act(() => openRowMenu({ chatId: null, history: ref }, anchor));
    const items = screen.getAllByRole('menuitem').map((m) => m.textContent);
    expect(items).toEqual(['Continue here', 'Open folder', 'Copy project path', 'Copy resume command']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Continue here' }));
    expect(store.getState().ui.openHistory).toEqual(ref);
  });
});

describe('buildTurns', () => {
  it('puts each tool call in the turn it happened in and streaming text in the last turn', () => {
    const msgs = [
      message({ id: 'u1', role: 'user', text: 'a', createdAt: '2026-10-23T10:00:00.000Z' }),
      message({ id: 'a1', text: 'b', createdAt: '2026-10-23T10:02:00.000Z' }),
      message({ id: 'u2', role: 'user', text: 'c', createdAt: '2026-10-23T10:05:00.000Z' }),
    ];
    const turns = buildTurns(msgs, [tool({ id: 't1', createdAt: '2026-10-23T10:01:00.000Z' }), tool({ id: 't2', createdAt: '2026-10-23T10:06:00.000Z' })], { s1: 'partial' }, true);
    expect(turns.map((t) => t.calls.map((c) => c.id))).toEqual([['t1'], ['t2']]);
    expect(turns[1]!.replies.map((r) => r.text)).toEqual(['partial']);
  });
});

describe('Composer: effort', () => {
  it('offers Quick, Normal and Thorough and saves the pick for the chat', async () => {
    mocked.patchChat.mockResolvedValue(chat({ title: 'Talk', column: 'review', effort: 'thorough' }));
    mount(seeded([chat({ title: 'Talk', column: 'review' })]));
    fireEvent.click(card('Talk'));
    fireEvent.click(within(panel()).getByRole('button', { name: 'Effort: Normal' }));
    const items = screen.getAllByRole('menuitemcheckbox');
    expect(items.map((i) => i.textContent?.split(/(?=[A-Z][a-z]+ )/)[0])).toEqual(['Quick', 'Normal', 'Thorough']);
    expect(items[1]!.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(items[2]!);
    await waitFor(() => expect(mocked.patchChat).toHaveBeenCalledWith('c1', { effort: 'thorough' }));
    await waitFor(() => expect(within(panel()).getByRole('button', { name: 'Effort: Thorough' })).toBeTruthy());
  });

  it('is hidden for a provider without an effort setting', async () => {
    mount(seeded([chat({ title: 'Anti', provider: 'antigravity', column: 'review' })]));
    fireEvent.click(card('Anti'));
    await flush();
    expect(within(panel()).queryByRole('button', { name: /^Effort/ })).toBeNull();
  });

  it('notes a reply that ran at an effort other than Normal', async () => {
    thread([message({ id: 'u', role: 'user', text: 'go' }), message({ id: 'a', text: 'done', effort: 'quick' })]);
    mount(seeded([chat({ title: 'Talk', column: 'review' })]));
    fireEvent.click(card('Talk'));
    await waitFor(() => expect(within(panel()).getByText('Quick effort')).toBeTruthy());
  });
});
