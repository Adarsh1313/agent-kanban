import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Chat } from '@agent-kanban/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client.ts';
import { applySnapshot, initialState } from '../src/state/reducer.ts';
import { createStore, StoreProvider, type Store } from '../src/state/store.ts';
import { Board } from '../src/ui/board/Board.tsx';
import { clockTime } from '../src/ui/board/format.ts';
import { ChatPanel } from '../src/ui/chat/ChatPanel.tsx';
import { ConnectionsPage } from '../src/ui/connections/ConnectionsPage.tsx';
import { Toasts } from '../src/ui/primitives/toast.tsx';
import { chat } from './helpers.ts';

vi.mock('../src/api/client.ts', async (orig) => {
  const m = await orig<typeof import('../src/api/client.ts')>();
  const fns = Object.fromEntries(['listMessages', 'listRequests', 'listToolCalls', 'patchChat', 'editQueued', 'removeQueued', 'sendQueuedNow', 'send', 'accounts', 'addAccount', 'activateAccount', 'resumeNow', 'codexResets', 'useCodexReset', 'checkConnections', 'history', 'projects'].map((k) => [k, vi.fn()]));
  return { ...m, api: { ...m.api, ...fns } };
});
const mocked = api as unknown as Record<string, ReturnType<typeof vi.fn>>;
const NOW = Date.parse('2026-11-01T10:00:00.000Z');
const RESET = '2026-11-01T12:40:00.000Z';

function seeded(chats: Chat[]): Store {
  const s = applySnapshot(initialState(), { chats, usage: [], suggested: null, connections: [], history: [], projects: [] });
  return createStore({ ...s, now: NOW });
}
const limited = (over: Partial<Chat> = {}) => chat({ title: 'Build the site', column: 'needs_you', needsReason: 'limit', resumeAt: RESET,
  queue: [{ id: 'q1', text: 'Then fix the footer' }, { id: 'q2', text: 'And the header' }], ...over });

beforeEach(() => {
  for (const f of Object.values(mocked)) f.mockReset?.();
  for (const k of ['listMessages', 'listRequests', 'listToolCalls']) mocked[k]!.mockResolvedValue([]);
  for (const k of ['patchChat', 'editQueued', 'removeQueued']) mocked[k]!.mockResolvedValue(limited());
  mocked.sendQueuedNow!.mockResolvedValue(undefined);
  mocked.accounts!.mockResolvedValue({ claude: [], codex: [] });
  mocked.codexResets!.mockResolvedValue({ available: 0 });
  for (const k of ['checkConnections', 'history', 'projects']) mocked[k]!.mockResolvedValue([]);
});
afterEach(cleanup);

describe('out of usage', () => {
  it('the card says when it resumes and how many messages are queued', () => {
    render(<StoreProvider store={seeded([limited()])}><Board /></StoreProvider>);
    const card = screen.getByRole('article', { name: 'Build the site' });
    expect(within(card).getByText(`Out of usage · resumes ${clockTime(RESET, NOW)}`)).toBeTruthy();
    expect(within(card).getByText('2 queued')).toBeTruthy();
  });

  it("Don't resume changes the card copy to the reset time without resuming", () => {
    render(<StoreProvider store={seeded([limited({ autoResume: false, queue: undefined })])}><Board /></StoreProvider>);
    expect(screen.getByText('Out of usage · resets later')).toBeTruthy();
  });

  it('the panel switches auto-resume and edits, removes and sends queued messages', async () => {
    const store = seeded([limited()]);
    store.setState((s) => ({ ...s, ui: { ...s.ui, openChatId: 'c1' } }));
    render(<StoreProvider store={store}><ChatPanel /><Toasts /></StoreProvider>);
    fireEvent.click(screen.getByRole('switch', { name: 'Continue on its own when usage resets' }));
    await waitFor(() => expect(mocked.patchChat).toHaveBeenCalledWith('c1', { autoResume: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit queued message: Then fix the footer' }));
    const input = screen.getByRole('textbox', { name: 'Edit queued message' });
    fireEvent.change(input, { target: { value: 'Fix the footer first' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(mocked.editQueued).toHaveBeenCalledWith('c1', 'q1', 'Fix the footer first'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove queued message: And the header' }));
    await waitFor(() => expect(mocked.removeQueued).toHaveBeenCalledWith('c1', 'q2'));
    fireEvent.click(screen.getAllByRole('button', { name: 'Send now' })[0]!);
    await waitFor(() => expect(mocked.sendQueuedNow).toHaveBeenCalledWith('c1', 'q1'));
    expect(screen.getByPlaceholderText('Queue a message. It goes out when it can continue')).toBeTruthy();
  });
});

describe('accounts', () => {
  it('an out-of-usage chat offers to switch to another account and continue', async () => {
    const store = seeded([limited({ provider: 'codex' })]);
    store.setState((s) => ({ ...s, ui: { ...s.ui, openChatId: 'c1' }, accounts: { codex: [
      { id: 'default', provider: 'codex', name: 'Default', active: true }, { id: 'w', provider: 'codex', name: 'Work', active: false }] } }));
    mocked.activateAccount!.mockResolvedValue([{ id: 'default', provider: 'codex', name: 'Default', active: false }, { id: 'w', provider: 'codex', name: 'Work', active: true }]);
    mocked.resumeNow!.mockResolvedValue(undefined);
    render(<StoreProvider store={store}><ChatPanel /><Toasts /></StoreProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Work and continue' }));
    await waitFor(() => expect(mocked.resumeNow).toHaveBeenCalledWith('c1'));
    expect(mocked.activateAccount).toHaveBeenCalledWith('codex', 'w');
    expect(store.getState().accounts.codex!.find((a) => a.active)!.name).toBe('Work');
  });

  it('Connections lists accounts, adds one and switches', async () => {
    const two = [{ id: 'default', provider: 'claude', name: 'Default', active: false }, { id: 'w', provider: 'claude', name: 'Work', active: true }];
    mocked.accounts!.mockResolvedValue({ claude: [{ id: 'default', provider: 'claude', name: 'Default', active: true }], codex: [] });
    mocked.addAccount!.mockResolvedValue(two);
    mocked.activateAccount!.mockResolvedValue(two.map((a) => ({ ...a, active: a.id === 'default' })));
    const store = seeded([]);
    store.setState((s) => applySnapshot(s, { chats: [], usage: [], suggested: null, history: [], projects: [], connections: [{
      provider: 'claude', installed: true, path: '/bin/claude', version: '1', latestVersion: '1', updateAvailable: false,
      signedIn: true, processOk: true, status: 'connected', message: null, checkedAt: new Date(NOW).toISOString() }] }));
    render(<StoreProvider store={store}><ConnectionsPage /><Toasts /></StoreProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Add another account' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Account name' }), { target: { value: 'Work' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(mocked.addAccount).toHaveBeenCalledWith('claude', 'Work'));
    fireEvent.click(await screen.findByRole('button', { name: 'Use this account' }));
    await waitFor(() => expect(mocked.activateAccount).toHaveBeenCalledWith('claude', 'default'));
  });
});

describe('Codex free resets', () => {
  it('shows the banked count on an out-of-usage Codex chat and uses one', async () => {
    mocked.codexResets!.mockResolvedValue({ available: 2 });
    mocked.useCodexReset!.mockResolvedValue({ outcome: 'reset' });
    const store = seeded([limited({ provider: 'codex', queue: undefined })]);
    store.setState((s) => ({ ...s, ui: { ...s.ui, openChatId: 'c1' } }));
    render(<StoreProvider store={store}><ChatPanel /><Toasts /></StoreProvider>);
    expect(await screen.findByText('2 free resets')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Use reset' }));
    await waitFor(() => expect(screen.getByText('1 free reset')).toBeTruthy());
    expect(mocked.useCodexReset).toHaveBeenCalled();
  });
});
