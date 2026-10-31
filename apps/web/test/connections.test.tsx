import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ConnectionHealth, ConnectState, HistoryChat, ProviderId, Settings, UsageReading } from '@agent-kanban/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/api/client.ts';
import { applyEvent, applySnapshot, initialState } from '../src/state/reducer.ts';
import { createStore, StoreProvider, type Store } from '../src/state/store.ts';
import { applyConnectEvent, ConnectionsPage } from '../src/ui/connections/ConnectionsPage.tsx';
import { dismissToast, toast, Toasts } from '../src/ui/primitives/toast.tsx';
import { usageSummary } from '../src/ui/usage/model.ts';

vi.mock('../src/api/client.ts', async (orig) => {
  const m = await orig<typeof import('../src/api/client.ts')>();
  return { ...m, api: { ...m.api, checkConnections: vi.fn(), connect: vi.fn(), patchSettings: vi.fn(), history: vi.fn(), projects: vi.fn() } };
});
type Fn = ReturnType<typeof vi.fn>;
const mocked = api as unknown as { checkConnections: Fn; connect: Fn; patchSettings: Fn; history: Fn; projects: Fn };

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

const ON = { claude: true, codex: true, antigravity: true };
const SETTINGS: Settings = { onboarded: true, showChats: ON, suggest: ON, hiddenProjects: [], unhiddenProjects: [], myProjects: null };
const cs = (provider: ProviderId, over: Partial<ConnectState> = {}): ConnectState => ({
  provider, phase: 'idle', step: null, progress: null, signInUrl: null, message: null, lastOp: null, outcome: null, updatedAt: ago(0), ...over,
});

function seeded(connections: ConnectionHealth[], usage: UsageReading[] = [], history: HistoryChat[] = [], connect: ConnectState[] = [], settings: Settings | null = SETTINGS): Store {
  const s = applySnapshot(initialState(), { chats: [], usage, suggested: null, connections, history, projects: [], connect, settings });
  return createStore({ ...s, now: NOW });
}
const btn = (id: ProviderId, name: string | RegExp) => within(card(id)).getByRole('button', { name });
const live = (store: Store, state: ConnectState) => act(() => store.setState((s) => applyEvent(s, { type: 'connect.updated', state })));
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

beforeEach(() => {
  for (const f of [mocked.checkConnections, mocked.connect, mocked.patchSettings, mocked.history, mocked.projects]) f.mockReset();
  mocked.history.mockResolvedValue([]);
  mocked.projects.mockResolvedValue([]);
  try { localStorage.clear(); } catch { /* none */ }
});
afterEach(() => {
  cleanup();
  // Toasts live in module state: clear the ones this test left.
  const last = toast('');
  for (let i = 1; i <= last; i++) dismissToast(i);
});

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
    expect(card('claude').textContent).toContain('Anthropic’s rules for using a subscription in other apps changed several times in 2026');

    expect(fact('codex', 'Chats found')).toBe('1');
    expect(fact('codex', 'Version')).toBe('0.156.1 · 0.157.0 available');
    expect([...card('codex').querySelectorAll('.conn-note')].map((n) => n.textContent)).toContain('gpt-5.5 isn’t available on your plan, so new chats use gpt-5.4.');
  });

  it('card names are headings; an update_available provider still reads Connected', () => {
    mount(seeded(ALL()));
    expect(within(card('codex')).getByRole('heading', { level: 4, name: 'Codex' })).toBeTruthy();
    expect(card('codex').dataset.state).toBe('connected');
    expect(within(card('codex')).getByRole('status').textContent).toBe('Connected');
  });

  it('not installed offers Install; signed out offers Sign in; the Antigravity card names Google’s official server', () => {
    mount(seeded([conn('claude', { status: 'signed_out', signedIn: false }), conn('codex'), ALL()[2]!]));
    expect(card('claude').dataset.state).toBe('signedout');
    expect(within(card('claude')).getByRole('status').textContent).toBe('Signed out');
    expect(card('claude').textContent).toContain('Installed. Sign in to finish setting up.');
    expect(card('claude').textContent).toContain('You’ll sign in on claude.ai in your browser, then come back here.');
    expect(btn('claude', 'Sign in to Claude Code')).toBeTruthy();

    expect(card('antigravity').dataset.state).toBe('missing');
    expect(within(card('antigravity')).getByRole('status').textContent).toBe('Not installed');
    expect(card('antigravity').textContent).toContain('Antigravity isn’t on this computer yet. Installing takes about a minute and uses the official Google installer.');
    expect(btn('antigravity', 'Install Antigravity')).toBeTruthy();
    expect(card('antigravity').textContent).toContain('Uses Google’s official Antigravity server.');
    expect(card('codex').textContent).not.toContain('Uses Google’s official Antigravity server.');
    expect(document.body.textContent).not.toContain('coming next');
  });

  it('a connected Antigravity says usage limits show only when it reports them', () => {
    mount(seeded([conn('antigravity')]));
    expect(card('antigravity').textContent).toContain('Usage limits show only when Antigravity reports them itself.');
    expect(card('antigravity').textContent).toContain('Uses Google’s official Antigravity server.');
  });

  it('a provider the server has no check for yet says Not connected once loaded', () => {
    mount(seeded([conn('claude'), conn('codex')], [], hist('antigravity', 2)));
    expect(card('antigravity').dataset.state).toBeUndefined();
    expect(within(card('antigravity')).getByRole('status').textContent).toBe('Not connected');
  });

  it('before the first load the cards say Checking…', () => {
    render(<StoreProvider store={createStore({ ...initialState(), now: NOW })}><ConnectionsPage /></StoreProvider>);
    expect(within(card('claude')).getByRole('status').textContent).toBe('Checking…');
    expect(within(card('claude')).queryByRole('button', { name: /Install|Sign in/ })).toBeNull();
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
    mount(seeded(ALL()));
    const b = btn('antigravity', 'Check now for Antigravity') as HTMLButtonElement;
    expect(b.textContent).toContain('Check now'); // the accessible name contains the visible label
    b.focus();
    fireEvent.click(b);
    expect(mocked.checkConnections).toHaveBeenCalledWith('antigravity');
    expect(b.getAttribute('aria-disabled')).toBe('true');
    expect(b.getAttribute('aria-busy')).toBe('true');
    expect(b.disabled).toBe(false);
    expect(document.activeElement).toBe(b);
    expect(b.querySelector('.icon.spinning')).toBeTruthy();
    fireEvent.click(b);
    expect(mocked.checkConnections).toHaveBeenCalledTimes(1);

    await act(async () => answer([{ ...ALL()[2]!, checkedAt: new Date(NOW).toISOString() }]));
    await waitFor(() => expect(b.getAttribute('aria-disabled')).toBeNull());
    expect(b.getAttribute('aria-busy')).toBeNull();
    expect(document.activeElement).toBe(b);
    expect(b.querySelector('.icon.spinning')).toBeNull();
    expect(card('antigravity').textContent).toContain('Checked just now');
  });

  it('Check for updates on a connected card checks, then says Up to date (or offers the update)', async () => {
    mocked.checkConnections.mockResolvedValueOnce([conn('claude', { checkedAt: new Date(NOW).toISOString() })]);
    mount(seeded(ALL()));
    fireEvent.click(btn('claude', 'Check for updates for Claude Code'));
    expect(mocked.checkConnections).toHaveBeenCalledWith('claude');
    await waitFor(() => expect(btn('claude', 'Up to date for Claude Code')).toBeTruthy());

    mocked.checkConnections.mockResolvedValueOnce([conn('claude', { latestVersion: '1.1.0', updateAvailable: true, status: 'update_available' })]);
    fireEvent.click(btn('claude', 'Up to date for Claude Code'));
    await waitFor(() => expect(btn('claude', 'Update to 1.1.0 for Claude Code')).toBeTruthy());
  });

  it('a failed check toasts the server text and leaves the card unchanged', async () => {
    mocked.checkConnections.mockRejectedValue(new ApiError('Couldn’t check Antigravity.', 500));
    mount(seeded(ALL()));
    const before = card('antigravity').innerHTML;
    fireEvent.click(btn('antigravity', 'Check now for Antigravity'));
    expect(await screen.findByText('Couldn’t check Antigravity.')).toBeTruthy();
    await waitFor(() => expect(btn('antigravity', 'Check now for Antigravity').getAttribute('aria-disabled')).toBeNull());
    expect(card('antigravity').innerHTML).toBe(before);
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

describe('connections actions', () => {
  it('Install calls the install route and shows the returned state; progress and steps follow live, Cancel cancels', async () => {
    mocked.connect.mockImplementation(async (provider: ProviderId, action: string) =>
      cs(provider, action === 'install' ? { phase: 'installing', step: 'Downloading Antigravity…', progress: 0 } : { phase: 'installing', step: 'Downloading Antigravity…', progress: 0.2 }));
    const store = seeded(ALL());
    mount(store);
    fireEvent.click(btn('antigravity', 'Install Antigravity'));
    expect(mocked.connect).toHaveBeenCalledWith('antigravity', 'install');
    await waitFor(() => expect(card('antigravity').dataset.state).toBe('installing'));
    expect(within(card('antigravity')).getByRole('status').textContent).toBe('Installing');
    expect(card('antigravity').querySelector('.step-text')!.textContent).toBe('Downloading Antigravity…');
    const bar = within(card('antigravity')).getByRole('progressbar', { name: 'Install progress' });
    expect(bar.getAttribute('aria-valuenow')).toBe('0');

    live(store, cs('antigravity', { phase: 'installing', step: 'Checking the download', progress: 0.75 }));
    expect(bar.getAttribute('aria-valuenow')).toBe('75');
    expect((bar.querySelector('i') as HTMLElement).style.getPropertyValue('--p')).toBe('0.75');
    // The step text crossfades: the old text blurs out first, then the new one comes in.
    await waitFor(() => expect(card('antigravity').querySelector('.step-text')!.textContent).toBe('Checking the download'));

    fireEvent.click(btn('antigravity', 'Cancel for Antigravity'));
    expect(mocked.connect).toHaveBeenLastCalledWith('antigravity', 'cancel');
  });

  it('an install that fails shows the server message and Try again installs again', () => {
    mocked.connect.mockResolvedValue(cs('antigravity', { phase: 'installing' }));
    const store = seeded(ALL());
    mount(store);
    live(store, cs('antigravity', { phase: 'error', message: 'The download didn’t finish. Try again.', lastOp: 'install', outcome: 'failed' }));
    expect(card('antigravity').dataset.state).toBe('error');
    expect(within(card('antigravity')).getByRole('status').textContent).toBe('Needs attention');
    expect(within(card('antigravity')).getByRole('alert').textContent).toBe('The download didn’t finish. Try again.');
    fireEvent.click(btn('antigravity', 'Try again for Antigravity'));
    expect(mocked.connect).toHaveBeenCalledWith('antigravity', 'install');
  });

  it('Sign in waits for the browser; Open the browser again uses the open route (never a link) and only with a sign-in page', async () => {
    mocked.connect.mockImplementation(async (provider: ProviderId, action: string) =>
      action === 'signin' ? cs(provider, { phase: 'signing_in', step: 'Finish signing in in your browser' }) : cs(provider, { phase: 'signing_in', signInUrl: 'https://auth.openai.com/x' }));
    const store = seeded([conn('claude'), conn('codex', { status: 'signed_out', signedIn: false })]);
    mount(store);
    fireEvent.click(btn('codex', 'Sign in to Codex'));
    expect(mocked.connect).toHaveBeenCalledWith('codex', 'signin');
    await waitFor(() => expect(card('codex').dataset.state).toBe('signin'));
    expect(within(card('codex')).getByRole('status').textContent).toBe('Waiting for sign-in');
    expect(card('codex').textContent).toContain('Finish signing in in your browser');
    expect(card('codex').textContent).toContain('We opened chatgpt.com. This page updates on its own when you’re done.');
    expect(within(card('codex')).queryByRole('button', { name: 'Open the browser again for Codex' })).toBeNull();

    live(store, cs('codex', { phase: 'signing_in', step: 'Finish signing in in your browser', signInUrl: 'https://auth.openai.com/oauth/authorize?x=1' }));
    expect(card('codex').querySelector('a[href]')).toBeNull();
    fireEvent.click(btn('codex', 'Open the browser again for Codex'));
    expect(mocked.connect).toHaveBeenLastCalledWith('codex', 'open');
    expect(await screen.findByText('Opened the sign-in page again')).toBeTruthy();

    fireEvent.click(btn('codex', 'Cancel for Codex'));
    expect(mocked.connect).toHaveBeenLastCalledWith('codex', 'cancel');
  });

  it('a sign-in that timed out goes back to Signed out with the server message', () => {
    const msg = "Sign-in didn't finish. Try again, and keep the browser window open until it says you're done.";
    mount(seeded([conn('codex', { status: 'signed_out', signedIn: false })], [], [], [cs('codex', { message: msg })]));
    expect(card('codex').dataset.state).toBe('signedout');
    // An idle message is a neutral note (role=status), not an alert.
    expect(within(card('codex')).queryByRole('alert')).toBeNull();
    const note = card('codex').querySelector('.conn-msg')!;
    expect(note.getAttribute('role')).toBe('status');
    expect(note.textContent).toBe(msg);
    expect(btn('codex', 'Sign in to Codex')).toBeTruthy();
  });

  it('a failed update keeps the card connected and shows why', () => {
    mount(seeded(ALL(), [], [], [cs('codex', { phase: 'error', message: 'Couldn’t install Codex. Try again, or install Codex yourself.' })]));
    expect(card('codex').dataset.state).toBe('connected');
    expect(within(card('codex')).getByRole('alert').textContent).toBe('Couldn’t install Codex. Try again, or install Codex yourself.');
    expect(btn('codex', 'Update to 0.157.0 for Codex')).toBeTruthy();
  });

  it('Update to x.y.z calls the update route and shows its progress', async () => {
    mocked.connect.mockResolvedValue(cs('codex', { phase: 'updating', step: 'Downloading Codex…', progress: 0.1 }));
    mount(seeded(ALL()));
    fireEvent.click(btn('codex', 'Update to 0.157.0 for Codex'));
    expect(mocked.connect).toHaveBeenCalledWith('codex', 'update');
    await waitFor(() => expect(within(card('codex')).getByRole('status').textContent).toBe('Updating'));
    expect(within(card('codex')).getByRole('progressbar', { name: 'Update progress' }).getAttribute('aria-valuenow')).toBe('10');
  });

  it('Sign out asks first (design text); Cancel keeps it, Sign out calls the route and toasts when done', async () => {
    mocked.connect.mockResolvedValue(cs('claude', { phase: 'signing_out', step: 'Signing out…' }));
    const store = seeded(ALL());
    mount(store);
    const so = btn('claude', 'Sign out of Claude Code');
    fireEvent.click(so);
    const pop = screen.getByRole('dialog', { name: 'Sign out of Claude Code?' });
    expect(pop.dataset.state).toBe('open');
    expect(pop.textContent).toContain('Agent Kanban stops starting Claude Code chats and reading its usage. Your chats stay in Claude Code, and running chats keep going there.');
    expect(document.activeElement).toBe(within(pop).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(pop).getByRole('button', { name: 'Cancel' }));
    expect(pop.dataset.state).toBe('closed');
    expect(mocked.connect).not.toHaveBeenCalled();

    fireEvent.click(so);
    fireEvent.click(within(pop).getByRole('button', { name: 'Sign out' }));
    expect(mocked.connect).toHaveBeenCalledWith('claude', 'signout');
    await waitFor(() => expect(within(card('claude')).getByRole('status').textContent).toBe('Signing out'));
    act(() => applyConnectEvent(store, cs('claude', { phase: 'idle', lastOp: 'signout', outcome: 'done', updatedAt: new Date(NOW + 1000).toISOString() })));
    expect(await screen.findByText('Signed out of Claude Code')).toBeTruthy();
  });

  it('a busy Antigravity sign-out toasts the server text and leaves the card as it was', async () => {
    mocked.connect.mockRejectedValue(new ApiError('Antigravity is busy. Wait for it to finish or cancel it.', 409));
    mount(seeded([conn('antigravity')]));
    fireEvent.click(btn('antigravity', 'Sign out of Antigravity'));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Sign out of Antigravity?' })).getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('Antigravity is busy. Wait for it to finish or cancel it.')).toBeTruthy();
    expect(card('antigravity').dataset.state).toBe('connected');
    expect(within(card('antigravity')).getByRole('status').textContent).toBe('Connected');
  });

  it('the switches patch settings; Show its chats refetches history and projects; a failure toasts and keeps the switch', async () => {
    const store = seeded(ALL());
    mount(store);
    const show = within(card('codex')).getByRole('switch', { name: 'Show Codex chats in the sidebar' });
    const sug = within(card('codex')).getByRole('switch', { name: 'Suggest Codex for new chats' });
    expect(show.getAttribute('aria-checked')).toBe('true');

    mocked.patchSettings.mockResolvedValueOnce({ ...SETTINGS, showChats: { ...ON, codex: false } });
    mocked.history.mockResolvedValueOnce(hist('claude', 1));
    fireEvent.click(show);
    expect(mocked.patchSettings).toHaveBeenCalledWith({ showChats: { codex: false } });
    await waitFor(() => expect(show.getAttribute('aria-checked')).toBe('false'));
    await waitFor(() => expect(store.getState().history).toHaveLength(1));
    expect(mocked.projects).toHaveBeenCalled();

    mocked.patchSettings.mockResolvedValueOnce({ ...SETTINGS, showChats: { ...ON, codex: false }, suggest: { ...ON, codex: false } });
    fireEvent.click(sug);
    expect(mocked.patchSettings).toHaveBeenLastCalledWith({ suggest: { codex: false } });
    await waitFor(() => expect(sug.getAttribute('aria-checked')).toBe('false'));
    expect(store.getState().settings!.suggest.codex).toBe(false);

    mocked.patchSettings.mockRejectedValueOnce(new ApiError('"suggest.codex" must be true or false.', 400));
    fireEvent.click(sug);
    expect(await screen.findByText('"suggest.codex" must be true or false.')).toBeTruthy();
    expect(sug.getAttribute('aria-checked')).toBe('false');
  });

  it('a refused action (busy) toasts the server text; the card is unchanged', async () => {
    mocked.connect.mockRejectedValue(new ApiError('Codex is busy. Wait for it to finish or cancel it.', 409));
    mount(seeded([conn('codex', { status: 'signed_out', signedIn: false })]));
    const before = card('codex').innerHTML;
    fireEvent.click(btn('codex', 'Sign in to Codex'));
    expect(await screen.findByText('Codex is busy. Wait for it to finish or cancel it.')).toBeTruthy();
    await waitFor(() => expect(card('codex').innerHTML).toBe(before));
  });
});

describe('more agents, coming later', () => {
  it('lists the later agents; Notify me is remembered in this browser only', async () => {
    mount(seeded(ALL()));
    expect(screen.getByRole('heading', { name: /More agents, coming later/ })).toBeTruthy();
    const later = screen.getByRole('region', { name: 'OpenCode' });
    expect(later.textContent).toContain('Free models');
    const b = within(later).getByRole('button', { name: /Notify me/ });
    expect(b.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(b);
    expect(b.getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(b.textContent).toContain('We’ll let you know'));
    expect(JSON.parse(localStorage.getItem('agent-kanban.notify-me')!)).toEqual(['OpenCode']);
    expect(mocked.connect).not.toHaveBeenCalled();
    cleanup();
    mount(seeded(ALL()));
    expect(within(screen.getByRole('region', { name: 'OpenCode' })).getByRole('button', { name: /We’ll let you know/ }).getAttribute('aria-pressed')).toBe('true');
  });

  it('Something else? thanks you for the name (empty: focuses the field)', async () => {
    mount(seeded(ALL()));
    const input = screen.getByRole('textbox', { name: 'Agent name' }) as HTMLInputElement;
    fireEvent.click(screen.getByRole('button', { name: 'Request' }));
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: '  Goose ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Request' }));
    expect(await screen.findByText('Thanks. We’ve noted Goose')).toBeTruthy();
    expect(input.value).toBe('');
  });
});

describe('connections fix round 1', () => {
  const later = (sec: number) => new Date(NOW + sec * 1000).toISOString();

  it('live transitions toast: signed in, updated to <version>; a cancel, a failure, a load or a resync does not', async () => {
    const store = seeded(ALL(), [], [], [cs('claude', { phase: 'signing_in' }), cs('codex', { phase: 'updating' })]);
    mount(store);
    act(() => applyConnectEvent(store, cs('claude', { lastOp: 'signin', outcome: 'done', updatedAt: later(1) })));
    expect(await screen.findByText('Claude Code is connected. Its chats now show in the sidebar and All chats')).toBeTruthy();
    act(() => applyConnectEvent(store, cs('codex', { lastOp: 'update', outcome: 'done', updatedAt: later(1) })));
    expect(await screen.findByText('Codex updated to 0.157.0')).toBeTruthy();

    // A sign-in that was cancelled is not announced.
    act(() => store.setState((s) => applyEvent(s, { type: 'connect.updated', state: cs('antigravity', { phase: 'signing_in', updatedAt: later(2) }) })));
    act(() => applyConnectEvent(store, cs('antigravity', { lastOp: 'signin', outcome: 'cancelled', updatedAt: later(3) })));
    // A resync that finds a finished sign-in is not announced either.
    act(() => store.setState((s) => applyEvent(s, { type: 'connect.updated', state: cs('antigravity', { phase: 'signing_in', updatedAt: later(4) }) })));
    act(() => store.setState((s) => applySnapshot(s, { chats: [], usage: [], suggested: null, connections: ALL(), history: [], projects: [], connect: [cs('antigravity', { lastOp: 'signin', outcome: 'done', updatedAt: later(5) })] })));
    expect(screen.queryByText('Antigravity is connected. Its chats now show in the sidebar and All chats')).toBeNull();
    expect(screen.queryAllByText(/is connected|updated to/)).toHaveLength(2);
  });

  it('nothing toasts on mount, even when the last operation was done', () => {
    mount(seeded(ALL(), [], [], [cs('claude', { lastOp: 'signin', outcome: 'done' })]));
    expect(screen.queryByText(/is connected/)).toBeNull();
  });

  it('Try again re-runs the operation that failed', () => {
    mocked.connect.mockResolvedValue(cs('codex', { phase: 'signing_in' }));
    mount(seeded([conn('codex', { status: 'signed_out', signedIn: false })], [], [], [cs('codex', { phase: 'error', message: 'x', lastOp: 'signin', outcome: 'failed' })]));
    fireEvent.click(btn('codex', 'Try again for Codex'));
    expect(mocked.connect).toHaveBeenCalledWith('codex', 'signin');
  });

  it('an error with no message says Something went wrong', () => {
    mount(seeded([ALL()[2]!], [], [], [cs('antigravity', { phase: 'error', lastOp: 'install', outcome: 'failed' })]));
    expect(within(card('antigravity')).getByRole('alert').textContent).toBe('Something went wrong. Try again.');
  });

  it('Sign in toasts that the browser was opened', async () => {
    mocked.connect.mockResolvedValue(cs('codex', { phase: 'signing_in' }));
    mount(seeded([conn('codex', { status: 'signed_out', signedIn: false })]));
    fireEvent.click(btn('codex', 'Sign in to Codex'));
    expect(await screen.findByText('Opened chatgpt.com in your browser')).toBeTruthy();
  });

  it('the progress bar reads out the current step', () => {
    mount(seeded(ALL(), [], [], [cs('antigravity', { phase: 'installing', step: 'Checking the download', progress: 0.7 })]));
    expect(within(card('antigravity')).getByRole('progressbar').getAttribute('aria-valuetext')).toBe('Checking the download');
  });

  it('when the view changes under the focus, focus moves to the card’s first action', async () => {
    mocked.connect.mockResolvedValue(cs('antigravity', { phase: 'installing', step: 'Downloading Antigravity…', progress: 0 }));
    mount(seeded(ALL()));
    const install = btn('antigravity', 'Install Antigravity');
    install.focus();
    fireEvent.click(install);
    await waitFor(() => expect(card('antigravity').dataset.state).toBe('installing'));
    expect(document.activeElement).toBe(btn('antigravity', 'Cancel for Antigravity'));
  });

  it('the Sign out button says it opens a dialog, and the confirm is a dialog', () => {
    mount(seeded(ALL()));
    const so = btn('claude', 'Sign out of Claude Code');
    expect(so.getAttribute('aria-haspopup')).toBe('dialog');
    fireEvent.click(so);
    expect(screen.getByRole('dialog', { name: 'Sign out of Claude Code?' })).toBeTruthy();
  });

  it('each switch has its own pending request: the other switch still works meanwhile, and the last click wins', async () => {
    let answer!: (v: Settings) => void;
    mocked.patchSettings.mockReturnValueOnce(new Promise((r) => { answer = r; }));
    mocked.patchSettings.mockResolvedValueOnce({ ...SETTINGS, suggest: { ...ON, codex: false } });
    mocked.patchSettings.mockResolvedValueOnce({ ...SETTINGS, suggest: { ...ON, codex: false } });
    mount(seeded(ALL()));
    const show = within(card('codex')).getByRole('switch', { name: 'Show Codex chats in the sidebar' });
    const sug = within(card('codex')).getByRole('switch', { name: 'Suggest Codex for new chats' });
    fireEvent.click(show);
    fireEvent.click(show); // remembered while its request runs, not sent yet
    expect(show.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sug);
    expect(mocked.patchSettings).toHaveBeenCalledTimes(2);
    expect(mocked.patchSettings).toHaveBeenLastCalledWith({ suggest: { codex: false } });
    await act(async () => answer({ ...SETTINGS, showChats: { ...ON, codex: false }, suggest: { ...ON, codex: false } }));
    // The first save said off; the last click asked for on, so it is saved again.
    await waitFor(() => expect(mocked.patchSettings).toHaveBeenCalledTimes(3));
    expect(mocked.patchSettings).toHaveBeenLastCalledWith({ showChats: { codex: true } });
    await waitFor(() => expect(show.getAttribute('aria-checked')).toBe('true'));
  });
});

describe('final review fixes', () => {
  const later = (sec: number) => new Date(NOW + sec * 1000).toISOString();

  it('right after a successful operation the card says Checking… until a newer health check arrives (I2)', () => {
    const store = seeded([conn('codex', { status: 'signed_out', signedIn: false, checkedAt: ago(1) })], [], [], [cs('codex', { lastOp: 'signin', outcome: 'done', updatedAt: ago(0) })]);
    mount(store);
    expect(card('codex').querySelector('.conn-state')!.textContent).toBe('Checking…');
    act(() => store.setState((s) => applyEvent(s, { type: 'connection.updated', health: conn('codex', { checkedAt: later(1) }) })));
    expect(card('codex').querySelector('.conn-state')!.textContent).toBe('Connected');
  });

  it('an older failure or a cancel is not hidden behind Checking…', () => {
    mount(seeded([conn('codex', { status: 'signed_out', signedIn: false, checkedAt: ago(1) })], [], [], [cs('codex', { lastOp: 'signin', outcome: 'cancelled', updatedAt: ago(0) })]));
    expect(card('codex').querySelector('.conn-state')!.textContent).toBe('Signed out');
  });

  it('Antigravity sign-in during a cold start shows the server step and the slow note until its link arrives (I3)', () => {
    const store = seeded([conn('antigravity', { status: 'signed_out', signedIn: false })], [], [], [cs('antigravity', { phase: 'signing_in', step: 'Starting Antigravity…' })]);
    mount(store);
    expect(card('antigravity').textContent).toContain('Starting Antigravity…');
    expect(card('antigravity').textContent).toContain('This can take a couple of minutes the first time.');
    expect(card('antigravity').textContent).not.toContain('We opened');
    live(store, cs('antigravity', { phase: 'signing_in', step: 'Finish signing in in your browser', signInUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1', updatedAt: later(1) }));
    expect(card('antigravity').textContent).toContain('Finish signing in in your browser');
    expect(card('antigravity').textContent).toContain('We opened Google sign-in.');
    expect(card('antigravity').textContent).not.toContain('couple of minutes');
  });

  it('Antigravity: "Opened Google sign-in in your browser" only once its link arrives (I3)', async () => {
    mocked.connect.mockResolvedValue(cs('antigravity', { phase: 'signing_in', step: 'Starting Antigravity…' }));
    const store = seeded([conn('antigravity', { status: 'signed_out', signedIn: false })]);
    mount(store);
    fireEvent.click(btn('antigravity', 'Sign in to Antigravity'));
    await waitFor(() => expect(mocked.connect).toHaveBeenCalledWith('antigravity', 'signin'));
    await waitFor(() => expect(card('antigravity').dataset.state).toBe('signin'));
    expect(screen.queryByText('Opened Google sign-in in your browser')).toBeNull();
    act(() => applyConnectEvent(store, cs('antigravity', { phase: 'signing_in', step: 'Finish signing in in your browser', signInUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1', updatedAt: later(1) })));
    expect(await screen.findByText('Opened Google sign-in in your browser')).toBeTruthy();
  });
});

describe('cardView after an operation', () => {
  it('a newer check with the same health ends Checking… (only checkedAt changed)', async () => {
    const { cardView } = await import('../src/ui/connections/ConnectionsPage.tsx');
    const done = cs('codex', { lastOp: 'signin', outcome: 'done', updatedAt: ago(0) });
    expect(cardView(conn('codex', { checkedAt: ago(1) }), done, true)).toBe('checking');
    expect(cardView(conn('codex', { checkedAt: new Date(NOW + 1000).toISOString() }), done, true)).toBe('connected');
  });
});
