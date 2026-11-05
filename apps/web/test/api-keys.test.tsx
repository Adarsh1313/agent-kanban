// Your own API keys (#43) in the web app: the Connections section, the nudge and its confirm, and the chat lines.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ApiKey, Chat, ConnectionHealth, ProviderId } from '@agent-kanban/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client.ts';
import { applyEvent, applySnapshot, initialState } from '../src/state/reducer.ts';
import { createStore, StoreProvider, type Store } from '../src/state/store.ts';
import { Board } from '../src/ui/board/Board.tsx';
import { ChatPanel } from '../src/ui/chat/ChatPanel.tsx';
import { DESKTOP_ONLY } from '../src/ui/connections/ApiKeys.tsx';
import { ConnectionsPage } from '../src/ui/connections/ConnectionsPage.tsx';
import { Toasts } from '../src/ui/primitives/toast.tsx';
import { chat } from './helpers.ts';

vi.mock('../src/api/client.ts', async (orig) => {
  const m = await orig<typeof import('../src/api/client.ts')>();
  const fns = Object.fromEntries(['keys', 'addKey', 'patchKey', 'removeKey', 'useKey', 'send', 'listMessages', 'listRequests', 'listToolCalls', 'accounts', 'codexResets',
    'checkConnections', 'history', 'projects', 'skills', 'claudeHooks'].map((k) => [k, vi.fn()]));
  return { ...m, api: { ...m.api, ...fns } };
});
const mocked = api as unknown as Record<string, ReturnType<typeof vi.fn>>;
const NOW = Date.parse('2026-11-05T10:00:00.000Z');

const key = (over: Partial<ApiKey> = {}): ApiKey => ({ id: 'k1', provider: 'claude', name: 'Personal', last4: '1a2b', capUsd: 10, spentUsd: 3.2, month: '2026-11', ...over });
const conn = (provider: ProviderId): ConnectionHealth => ({
  provider, installed: true, path: `/bin/${provider}`, version: '1.0.0', latestVersion: '1.0.0', updateAvailable: false,
  signedIn: true, processOk: true, status: 'connected', message: null, checkedAt: new Date(NOW).toISOString(),
});

function seeded(chats: Chat[] = [], keys: ApiKey[] | null = null): Store {
  const s = applySnapshot(initialState(), { chats, usage: [], suggested: null, connections: [conn('claude'), conn('codex')], history: [], projects: [] });
  return createStore({ ...s, keys, now: NOW });
}
const desktop = () => { (window as { agentKanbanDesktop?: unknown }).agentKanbanDesktop = { status: () => {}, show: () => {}, theme: () => {}, onOpenChat: () => () => {} }; };
const claudeCard = () => document.querySelector<HTMLElement>('[data-conn="claude"]')!;

beforeEach(() => {
  for (const f of Object.values(mocked)) f.mockReset?.();
  for (const k of ['listMessages', 'listRequests', 'listToolCalls', 'checkConnections', 'history', 'projects']) mocked[k]!.mockResolvedValue([]);
  mocked.accounts!.mockResolvedValue({ claude: [], codex: [] });
  mocked.codexResets!.mockResolvedValue({ available: 0 });
  mocked.skills!.mockResolvedValue({ synced: [], skipped: [] });
  mocked.claudeHooks!.mockResolvedValue({ installed: false });
  mocked.keys!.mockResolvedValue([]);
});
afterEach(() => { cleanup(); delete (window as { agentKanbanDesktop?: unknown }).agentKanbanDesktop; });

describe('Connections · API keys', () => {
  it('browser mode: no key section, just a line saying keys work in the desktop app', () => {
    render(<StoreProvider store={seeded()}><ConnectionsPage /></StoreProvider>);
    expect(within(claudeCard()).getByText(DESKTOP_ONLY)).toBeTruthy();
    expect(within(claudeCard()).queryByRole('button', { name: /Add an API key/ })).toBeNull();
    expect(mocked.keys).not.toHaveBeenCalled();
  });

  it('shows each key masked, with the cap and this month\'s spend', async () => {
    desktop();
    mocked.keys!.mockResolvedValue([key(), key({ id: 'k2', provider: 'codex', name: 'Work', last4: '9z9z', capUsd: null, spentUsd: 0 })]);
    render(<StoreProvider store={seeded()}><ConnectionsPage /></StoreProvider>);
    await waitFor(() => expect(within(claudeCard()).getByText('Personal', { selector: '.api-key-name' })).toBeTruthy());
    expect(within(claudeCard()).getByText('••••1a2b')).toBeTruthy();
    expect(within(claudeCard()).getByText('$3.20 of $10 this month')).toBeTruthy();
    expect(within(claudeCard()).queryByText('Work', { selector: '.api-key-name' })).toBeNull();
    const codex = document.querySelector<HTMLElement>('[data-conn="codex"]')!;
    expect(within(codex).getByText('$0.00 this month')).toBeTruthy();
    expect(within(claudeCard()).getByText(/Stored encrypted on this computer/)).toBeTruthy();
  });

  it('adds a key from a password field and shows only its last 4', async () => {
    desktop();
    mocked.addKey!.mockResolvedValue(key({ capUsd: null, spentUsd: 0 }));
    mocked.patchKey!.mockResolvedValue(key({ spentUsd: 0 }));
    render(<StoreProvider store={seeded([], [])}><ConnectionsPage /><Toasts /></StoreProvider>);
    fireEvent.click(within(claudeCard()).getByRole('button', { name: /Add an API key/ }));
    const field = within(claudeCard()).getByLabelText('API key') as HTMLInputElement;
    expect(field.type).toBe('password');
    fireEvent.change(within(claudeCard()).getByLabelText('Name'), { target: { value: 'Personal' } });
    fireEvent.change(field, { target: { value: 'sk-ant-secret-1a2b' } });
    fireEvent.change(within(claudeCard()).getByLabelText('Monthly spend cap'), { target: { value: '10' } });
    fireEvent.click(within(claudeCard()).getByRole('button', { name: 'Save key' }));
    await waitFor(() => expect(within(claudeCard()).getByText('••••1a2b')).toBeTruthy());
    expect(mocked.addKey).toHaveBeenCalledWith('claude', 'Personal', 'sk-ant-secret-1a2b');
    expect(mocked.patchKey).toHaveBeenCalledWith('k1', { capUsd: 10 });
    expect(document.body.textContent).not.toContain('sk-ant-secret');
  });

  it('asks before deleting a key', async () => {
    desktop();
    mocked.removeKey!.mockResolvedValue(undefined);
    render(<StoreProvider store={seeded([], [key()])}><ConnectionsPage /><Toasts /></StoreProvider>);
    fireEvent.click(within(claudeCard()).getByRole('button', { name: 'Delete Personal' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Personal?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete key' }));
    await waitFor(() => expect(mocked.removeKey).toHaveBeenCalledWith('k1'));
  });
});

describe('Chats on a key', () => {
  const limited = (over: Partial<Chat> = {}) => chat({ provider: 'claude', title: 'Build the site', column: 'needs_you', needsReason: 'limit', ...over });
  const open = (store: Store) => { store.setState((s) => ({ ...s, ui: { ...s.ui, openChatId: 'c1' } })); return store; };

  it('the out-of-usage nudge offers the key; the confirm shows the cap and says billed per use', async () => {
    desktop();
    mocked.useKey!.mockResolvedValue(limited({ keyId: 'k1', column: 'running', needsReason: null }));
    render(<StoreProvider store={open(seeded([limited()], [key()]))}><ChatPanel /><Toasts /></StoreProvider>);
    fireEvent.click(screen.getByRole('button', { name: /Continue with API key 'Personal'/ }));
    const dialog = await screen.findByRole('dialog', { name: "Continue with API key 'Personal'?" });
    expect(within(dialog).getByText(/billed per use by Anthropic/)).toBeTruthy();
    expect(within(dialog).getByText('Spend cap: $10 a month. $3.20 used so far.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(mocked.useKey).toHaveBeenCalledWith('c1', 'k1'));
  });

  it('no nudge for a key at its cap, or in browser mode', () => {
    desktop();
    const { unmount } = render(<StoreProvider store={open(seeded([limited()], [key({ spentUsd: 10 })]))}><ChatPanel /></StoreProvider>);
    expect(screen.queryByRole('button', { name: /Continue with API key/ })).toBeNull();
    unmount();
    delete (window as { agentKanbanDesktop?: unknown }).agentKanbanDesktop;
    render(<StoreProvider store={open(seeded([limited()], [key()]))}><ChatPanel /></StoreProvider>);
    expect(screen.queryByRole('button', { name: /Continue with API key/ })).toBeNull();
  });

  it('a chat running on a key says so', () => {
    desktop();
    render(<StoreProvider store={open(seeded([limited({ keyId: 'k1', column: 'running', needsReason: null })], [key()]))}><ChatPanel /></StoreProvider>);
    expect(screen.getByText("Using API key 'Personal' · $3.20 of $10 this month")).toBeTruthy();
  });

  it('Spend cap reached: the card badge, and the panel offers the plan instead', async () => {
    desktop();
    const capped = limited({ keyId: 'k1', needsReason: 'spend-cap' });
    const store = seeded([capped], [key({ spentUsd: 10 })]);
    render(<StoreProvider store={store}><Board /></StoreProvider>);
    expect(within(screen.getByRole('article', { name: 'Build the site' })).getByText('Spend cap reached')).toBeTruthy();
    cleanup();
    mocked.useKey!.mockResolvedValue(capped);
    mocked.send!.mockResolvedValue(undefined);
    render(<StoreProvider store={open(store)}><ChatPanel /><Toasts /></StoreProvider>);
    expect(screen.getByText(/reached its \$10 cap for this month/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue on your plan' }));
    await waitFor(() => expect(mocked.send).toHaveBeenCalled());
    expect(mocked.useKey).toHaveBeenCalledWith('c1', null);
  });

  it('keys.updated keeps the spend line live', () => {
    const s = applyEvent(initialState(), { type: 'keys.updated', keys: [key({ spentUsd: 4.5 })] });
    expect(s.keys?.[0]?.spentUsd).toBe(4.5);
  });
});
