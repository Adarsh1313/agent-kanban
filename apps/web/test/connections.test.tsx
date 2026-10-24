import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ConnectionHealth, HistoryChat, ProviderId, UsageReading } from '@agent-kanban/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/api/client.ts';
import { applyEvent, applySnapshot, initialState } from '../src/state/reducer.ts';
import { createStore, StoreProvider, type Store } from '../src/state/store.ts';
import { ConnectionsPage } from '../src/ui/connections/ConnectionsPage.tsx';
import { Toasts } from '../src/ui/primitives/toast.tsx';
import { usageSummary } from '../src/ui/usage/model.ts';

vi.mock('../src/api/client.ts', async (orig) => {
  const m = await orig<typeof import('../src/api/client.ts')>();
  return { ...m, api: { ...m.api, checkConnections: vi.fn() } };
});
const mocked = api as unknown as { checkConnections: ReturnType<typeof vi.fn> };

const NOW = Date.parse('2026-10-23T12:00:00.000Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

const conn = (provider: ProviderId, over: Partial<ConnectionHealth> = {}): ConnectionHealth => ({
  provider, installed: true, path: `/usr/local/bin/${provider}`, version: '1.0.0', latestVersion: '1.0.0', updateAvailable: false,
  signedIn: true, processOk: true, status: 'connected', message: null, checkedAt: ago(2), ...over,
});
const reading = (provider: ProviderId, five: number, week: number): UsageReading => ({
  provider, status: 'ok', readAt: ago(1),
  windows: [{ kind: 'five_hour', label: '5-hour', leftPct: five, resetsAt: null }, { kind: 'weekly', label: 'Weekly', leftPct: week, resetsAt: null }],
});
const hist = (provider: ProviderId, n: number): HistoryChat[] =>
  Array.from({ length: n }, (_, i) => ({ provider, sessionRef: `${provider}-${i}`, title: 't', cwd: '/w', updatedAt: ago(100) }));

function seeded(connections: ConnectionHealth[], usage: UsageReading[] = [], history: HistoryChat[] = []): Store {
  const s = applySnapshot(initialState(), { chats: [], usage, suggested: null, connections, history, projects: [] });
  return createStore({ ...s, now: NOW });
}
const mount = (store: Store) => render(<StoreProvider store={store}><ConnectionsPage /><Toasts /></StoreProvider>);
const card = (id: ProviderId) => document.querySelector<HTMLElement>(`[data-conn="${id}"]`)!;
const fact = (id: ProviderId, term: string) => {
  const dt = [...card(id).querySelectorAll('dt')].find((d) => d.textContent === term);
  return dt?.nextElementSibling?.textContent ?? null;
};

const ALL = () => [
  conn('claude'),
  conn('codex', { version: '0.156.1', latestVersion: '0.157.0', updateAvailable: true, status: 'update_available', message: 'gpt-5.5 isn’t available on your plan, so new chats use gpt-5.4.' }),
  conn('antigravity', { installed: false, path: null, version: null, latestVersion: null, signedIn: null, status: 'not_installed' }),
];

beforeEach(() => { mocked.checkConnections.mockReset(); });
afterEach(() => { cleanup(); });

describe('usageSummary', () => {
  it('reads both windows, or says why it cannot', () => {
    expect(usageSummary(reading('claude', 82, 64))).toBe('82% of 5-hour · 64% of weekly left');
    expect(usageSummary(undefined)).toBe('Checking…');
    expect(usageSummary(reading('claude', 82, 64), false)).toBe('Not connected');
  });
});

describe('connections page', () => {
  it('shows one card per provider with status, version, latest, sign-in, chats found and usage', () => {
    mount(seeded(ALL(), [reading('claude', 82, 64)], [...hist('claude', 3), ...hist('codex', 1)]));
    expect(screen.getByRole('heading', { name: 'Connections' })).toBeTruthy();
    expect(document.querySelector('.page-head .source')!.textContent).toBe('2 of 3 connected');

    expect(card('claude').dataset.state).toBe('connected');
    expect(within(card('claude')).getByRole('status').textContent).toBe('Connected');
    expect(fact('claude', 'Version')).toBe('1.0.0');
    expect(fact('claude', 'Latest')).toBe('1.0.0');
    expect(fact('claude', 'Signed in')).toBe('Yes');
    expect(fact('claude', 'Chats found')).toBe('3');
    expect(fact('claude', 'Usage')).toBe('82% of 5-hour · 64% of weekly left');
    expect(card('claude').textContent).toContain('Checked 2m ago');
    expect(card('claude').textContent).not.toContain('Setup from the app is coming next.');

    expect(fact('codex', 'Chats found')).toBe('1');
    expect(fact('codex', 'Version')).toBe('0.156.1 · Update available: 0.157.0');
    expect(card('codex').querySelector('.conn-note')!.textContent).toBe('gpt-5.5 isn’t available on your plan, so new chats use gpt-5.4.');
  });

  it('a provider that is not installed or signed out says setup is coming next; Antigravity says chats are coming next', () => {
    mount(seeded([conn('claude', { status: 'signed_out', signedIn: false }), conn('codex'), ALL()[2]!]));
    expect(card('claude').dataset.state).toBe('signedout');
    expect(within(card('claude')).getByRole('status').textContent).toBe('Signed out');
    expect(fact('claude', 'Signed in')).toBe('No');
    expect(card('claude').textContent).toContain('Setup from the app is coming next.');
    expect(card('codex').textContent).not.toContain('Setup from the app is coming next.');

    expect(card('antigravity').dataset.state).toBe('missing');
    expect(within(card('antigravity')).getByRole('status').textContent).toBe('Not installed');
    expect(card('antigravity').textContent).toContain('Antigravity isn’t on this computer yet.');
    expect(card('antigravity').textContent).toContain('Setup from the app is coming next.');
    expect(card('antigravity').textContent).toContain('Chats with Antigravity are coming next.');
  });

  it('a provider the server has no check for yet says Not connected once loaded', () => {
    mount(seeded([conn('claude'), conn('codex')], [], hist('antigravity', 2)));
    expect(card('antigravity').dataset.state).toBeUndefined();
    expect(within(card('antigravity')).getByRole('status').textContent).toBe('Not connected');
    expect(card('antigravity').textContent).toContain('Setup from the app is coming next.');
    expect(card('antigravity').textContent).toContain('Chats with Antigravity are coming next.');
  });

  it('before the first load the cards say Checking…', () => {
    render(<StoreProvider store={createStore({ ...initialState(), now: NOW })}><ConnectionsPage /></StoreProvider>);
    expect(within(card('claude')).getByRole('status').textContent).toBe('Checking…');
    expect(card('claude').textContent).not.toContain('Setup from the app is coming next.');
  });

  it('a degraded provider needs attention and shows the server message', () => {
    mount(seeded([conn('claude', { status: 'degraded', processOk: false, message: 'Claude Code didn’t start.' })]));
    expect(card('claude').dataset.state).toBe('error');
    expect(within(card('claude')).getByRole('status').textContent).toBe('Needs attention');
    expect(card('claude').textContent).toContain('Claude Code didn’t start.');
  });

  it('Check now asks the server for that provider, spins while it runs, and applies the answer', async () => {
    let answer!: (v: ConnectionHealth[]) => void;
    mocked.checkConnections.mockReturnValue(new Promise((r) => { answer = r; }));
    const store = seeded(ALL());
    mount(store);
    const btn = within(card('codex')).getByRole('button', { name: 'Check Codex now' }) as HTMLButtonElement;
    fireEvent.click(btn);
    expect(mocked.checkConnections).toHaveBeenCalledWith('codex');
    expect(btn.disabled).toBe(true);
    expect(btn.querySelector('.icon.spinning')).toBeTruthy();
    fireEvent.click(btn);
    expect(mocked.checkConnections).toHaveBeenCalledTimes(1);

    await act(async () => answer([conn('codex', { version: '0.157.0', checkedAt: new Date(NOW).toISOString() })]));
    await waitFor(() => expect(btn.disabled).toBe(false));
    expect(btn.querySelector('.icon.spinning')).toBeNull();
    expect(fact('codex', 'Version')).toBe('0.157.0');
    expect(card('codex').textContent).toContain('Checked just now');
    expect(card('codex').textContent).not.toContain('Update available');
  });

  it('a failed check toasts the server text and leaves the card unchanged', async () => {
    mocked.checkConnections.mockRejectedValue(new ApiError('Couldn’t check Codex.', 500));
    mount(seeded(ALL()));
    const before = card('codex').innerHTML;
    fireEvent.click(within(card('codex')).getByRole('button', { name: 'Check Codex now' }));
    expect(await screen.findByText('Couldn’t check Codex.')).toBeTruthy();
    await waitFor(() => expect((within(card('codex')).getByRole('button', { name: 'Check Codex now' }) as HTMLButtonElement).disabled).toBe(false));
    expect(card('codex').innerHTML).toBe(before);
  });

  it('connection.updated events update the card live', () => {
    const store = seeded(ALL());
    mount(store);
    act(() => store.setState((s) => applyEvent(s, { type: 'connection.updated', health: conn('antigravity', { version: '1.1.11', latestVersion: '1.1.11' }) })));
    expect(card('antigravity').dataset.state).toBe('connected');
    expect(fact('antigravity', 'Version')).toBe('1.1.11');
    expect(document.querySelector('.page-head .source')!.textContent).toBe('3 of 3 connected');
  });
});
