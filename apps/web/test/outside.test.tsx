import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Chat } from '@agent-kanban/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client.ts';
import { applyEvent, applySnapshot, initialState } from '../src/state/reducer.ts';
import { createStore, StoreProvider, type Store } from '../src/state/store.ts';
import { Board } from '../src/ui/board/Board.tsx';
import { ChatPanel, OUTSIDE_NOTE } from '../src/ui/chat/ChatPanel.tsx';
import { ConnectionsPage } from '../src/ui/connections/ConnectionsPage.tsx';
import { Toasts } from '../src/ui/primitives/toast.tsx';
import { chat } from './helpers.ts';

vi.mock('../src/api/client.ts', async (orig) => {
  const m = await orig<typeof import('../src/api/client.ts')>();
  const fns = Object.fromEntries(['listMessages', 'listRequests', 'listToolCalls', 'historyMessages', 'claudeHooks', 'setClaudeHooks', 'history', 'projects', 'checkConnections'].map((k) => [k, vi.fn()]));
  return { ...m, api: { ...m.api, ...fns } };
});
const mocked = api as unknown as Record<string, ReturnType<typeof vi.fn>>;
const NOW = Date.parse('2026-10-23T12:00:00.000Z');

function seeded(chats: Chat[]): Store {
  const s = applySnapshot(initialState(), { chats, usage: [], suggested: null, connections: [], history: [], projects: [] });
  return createStore({ ...s, now: NOW });
}

beforeEach(() => {
  for (const f of Object.values(mocked)) f.mockReset?.();
  for (const k of ['listMessages', 'listRequests', 'listToolCalls', 'history', 'projects', 'checkConnections']) mocked[k]!.mockResolvedValue([]);
  mocked.historyMessages!.mockResolvedValue({ messages: [], truncated: false });
});
afterEach(cleanup);

const outside = (over: Partial<Chat> = {}) => chat({ title: 'Fix the footer', origin: 'outside', outsideLive: true, ...over });

describe('outside chats', () => {
  it('a live outside card is marked and has no Stop', () => {
    render(<StoreProvider store={seeded([outside()])}><Board /></StoreProvider>);
    const card = screen.getByRole('article', { name: 'Fix the footer' });
    expect(card.textContent).toContain('Outside the app');
    expect(card.querySelector('[aria-label="Stop agent"]')).toBeNull();
  });

  it('needs-you waiting reads "Waiting for you"', () => {
    render(<StoreProvider store={seeded([outside({ column: 'needs_you', needsReason: 'waiting' })])}><Board /></StoreProvider>);
    expect(screen.getByText('Waiting for you')).toBeTruthy();
  });

  it('the panel replaces the composer while it runs outside, and offers it once stopped', async () => {
    const store = seeded([outside()]);
    store.setState((s) => ({ ...s, ui: { ...s.ui, openChatId: 'c1' } }));
    render(<StoreProvider store={store}><ChatPanel /><Toasts /></StoreProvider>);
    expect(screen.getByText(OUTSIDE_NOTE)).toBeTruthy();
    expect(screen.queryByPlaceholderText('Continue this chat here')).toBeNull();
    act(() => store.setState((s) => applyEvent(s, { type: 'chat.updated', chat: outside({ outsideLive: false, column: 'review' }) })));
    expect(await screen.findByPlaceholderText('Continue this chat here')).toBeTruthy();
  });

  it('Connections asks whether the hooks are installed and switches them', async () => {
    mocked.claudeHooks!.mockResolvedValue({ installed: false });
    mocked.setClaudeHooks!.mockResolvedValue({ installed: true });
    const store = seeded([]);
    store.setState((s) => applySnapshot(s, { chats: [], usage: [], suggested: null, history: [], projects: [], connections: [{
      provider: 'claude', installed: true, path: '/bin/claude', version: '1', latestVersion: '1', updateAvailable: false,
      signedIn: true, processOk: true, status: 'connected', message: null, checkedAt: new Date(NOW).toISOString() }] }));
    render(<StoreProvider store={store}><ConnectionsPage /></StoreProvider>);
    const sw = await screen.findByRole('switch', { name: 'Show Claude Code chats you run outside the app' });
    await waitFor(() => expect((sw as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(sw);
    await waitFor(() => expect(mocked.setClaudeHooks).toHaveBeenCalledWith(true));
    await waitFor(() => expect(store.getState().claudeHooks).toBe(true));
    act(() => store.setState((s) => applyEvent(s, { type: 'hooks.updated', installed: false })));
    expect(store.getState().claudeHooks).toBe(false);
  });
});
