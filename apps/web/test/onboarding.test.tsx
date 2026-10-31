import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ConnectionHealth, ConnectState, HistoryChat, Project, ProviderId, Settings } from '@agent-kanban/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/api/client.ts';
import { applyEvent, applySnapshot, initialState } from '../src/state/reducer.ts';
import { createStore, StoreProvider, type Store } from '../src/state/store.ts';
import { setNewChatHandler } from '../src/ui/actions.ts';
import { notificationsLine, Onboarding, replayOnboarding } from '../src/ui/onboarding/Onboarding.tsx';
import { applyConnectEvent } from '../src/ui/connections/ConnectionsPage.tsx';
import { setPrefs } from '../src/ui/notify/notifier.ts';
import { dismissToast, toast, Toasts } from '../src/ui/primitives/toast.tsx';
import { hasOpenLayer } from '../src/ui/primitives/layers.ts';
import { Sidebar } from '../src/ui/shell/Sidebar.tsx';

vi.mock('../src/api/client.ts', async (orig) => {
  const m = await orig<typeof import('../src/api/client.ts')>();
  return { ...m, api: { ...m.api, checkConnections: vi.fn(), connect: vi.fn(), patchSettings: vi.fn(), skills: vi.fn(async () => ({ synced: [], skipped: [] })), history: vi.fn(), projects: vi.fn() } };
});
type Fn = ReturnType<typeof vi.fn>;
const mocked = api as unknown as { checkConnections: Fn; connect: Fn; patchSettings: Fn; history: Fn; projects: Fn };

const NOW = Date.parse('2026-10-23T12:00:00.000Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const ON = { claude: true, codex: true, antigravity: true };
const settings = (over: Partial<Settings> = {}): Settings => ({ onboarded: false, showChats: { ...ON }, suggest: { ...ON }, hiddenProjects: [], unhiddenProjects: [], ...over });

const conn = (provider: ProviderId, over: Partial<ConnectionHealth> = {}): ConnectionHealth => ({
  provider, installed: true, path: `/bin/${provider}`, version: '1.0.0', latestVersion: '1.0.0', updateAvailable: false,
  signedIn: true, processOk: true, status: 'connected', message: null, checkedAt: ago(1), ...over,
});
const signedOut = (p: ProviderId) => conn(p, { signedIn: false, status: 'signed_out' });
const missing = (p: ProviderId) => conn(p, { installed: false, path: null, version: null, signedIn: null, status: 'not_installed' });
const cs = (provider: ProviderId, over: Partial<ConnectState> = {}): ConnectState => ({
  provider, phase: 'idle', step: null, progress: null, signInUrl: null, message: null, lastOp: null, outcome: null, updatedAt: ago(0), ...over,
});
const hist = (provider: ProviderId, n: number, cwd = '/w/alpha'): HistoryChat[] =>
  Array.from({ length: n }, (_, i) => ({ provider, sessionRef: `${provider}-${i}`, title: 't', cwd, updatedAt: ago(100) }));
const project = (id: string, providers: ProviderId[]): Project => ({
  id, name: id.split('/').pop()!, path: id, providers: providers.map((provider) => ({ provider, chats: 1, lastUsedAt: ago(5), lastModel: null })),
  columns: { running: 0, needs_you: 0, review: 0, done: 0 }, historyOnly: 1, lastActivityAt: ago(5),
} as unknown as Project);

function seeded(connections: ConnectionHealth[], opts: { settings?: Settings | null; history?: HistoryChat[]; projects?: Project[]; connect?: ConnectState[] } = {}): Store {
  const s = applySnapshot(initialState(), {
    chats: [], usage: [], suggested: null, connections, history: opts.history ?? [], projects: opts.projects ?? [], connect: opts.connect ?? [],
    settings: opts.settings === undefined ? settings() : opts.settings,
  });
  return createStore({ ...s, now: NOW });
}
const mount = (store: Store) => render(<StoreProvider store={store}><main id="main" tabIndex={-1} /><Onboarding /><Toasts /></StoreProvider>);
const dialog = () => screen.queryByRole('dialog', { name: 'Set up Agent Kanban' });
const primary = (name: string | RegExp) => screen.getByRole('button', { name });
const row = (id: ProviderId) => document.querySelector<HTMLElement>(`[data-agent="${id}"]`)!;

beforeEach(() => {
  for (const f of [mocked.checkConnections, mocked.connect, mocked.patchSettings, mocked.history, mocked.projects]) f.mockReset();
  mocked.history.mockResolvedValue([]);
  mocked.projects.mockResolvedValue([]);
  try { localStorage.clear(); } catch { /* none */ }
});
afterEach(() => {
  cleanup();
  setNewChatHandler(null);
  const last = toast('');
  for (let i = 1; i <= last; i++) dismissToast(i);
});

describe('onboarding gating', () => {
  it('is not shown before the first snapshot has loaded, nor for an onboarded user', () => {
    const fresh = createStore({ ...initialState(), now: NOW });
    const { unmount } = mount(fresh);
    expect(dialog()).toBeNull();
    unmount();
    mount(seeded([conn('claude')], { settings: settings({ onboarded: true }) }));
    expect(dialog()).toBeNull();
  });

  it('shows the Welcome step when settings say not onboarded; the shell behind is inert and Escape does not skip it', () => {
    const store = seeded([conn('claude')]);
    const { container } = mount(store);
    expect(dialog()).not.toBeNull();
    expect(screen.getByRole('heading', { name: /All your coding agents/ })).toBeTruthy();
    expect(document.activeElement).toBe(primary('Get started'));
    expect(container.inert).toBe(true);
    expect(hasOpenLayer()).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(dialog()).not.toBeNull();
  });

  it('Replay onboarding (Settings menu) shows it again without writing to the server', () => {
    const store = seeded([conn('claude')], { settings: settings({ onboarded: true }) });
    render(<StoreProvider store={store}><Sidebar /><Onboarding /></StoreProvider>);
    expect(dialog()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Replay onboarding' }));
    expect(store.getState().settings?.onboarded).toBe(false);
    expect(dialog()).not.toBeNull();
    expect(mocked.patchSettings).not.toHaveBeenCalled();
  });

  it('replayOnboarding does nothing before settings have loaded', () => {
    const store = createStore(initialState());
    replayOnboarding(store);
    expect(store.getState().settings).toBeNull();
  });
});

describe('connect step', () => {
  it('Continue stays disabled until one provider is connected; one detected later enables it and shows Connected (no reinstall)', () => {
    const store = seeded([signedOut('claude'), missing('codex'), missing('antigravity')]);
    mount(store);
    fireEvent.click(primary('Get started'));
    expect(screen.getByRole('heading', { name: 'Connect the agents you use' })).toBeTruthy();
    const cont = primary('Continue') as HTMLButtonElement;
    expect(cont.disabled).toBe(true);
    expect(screen.getByText('Connect at least one to continue.')).toBeTruthy();
    expect(within(row('claude')).getByRole('button', { name: /Sign in/ })).toBeTruthy();
    expect(within(row('codex')).getByRole('button', { name: /Install/ })).toBeTruthy();

    // Installed and signed in outside the app: the next health check flips the row.
    act(() => store.setState((s) => applyEvent(s, { type: 'connection.updated', health: conn('codex') } as never)));
    expect(within(row('codex')).getByText('Connected')).toBeTruthy();
    expect(within(row('codex')).queryByRole('button')).toBeNull();
    expect((primary('Continue') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText('1 connected. You can add more later in Connections.')).toBeTruthy();
  });

  it('already-connected providers show Connected at once, with no Install or Sign in', () => {
    mount(seeded([conn('claude'), conn('codex', { status: 'update_available', updateAvailable: true, latestVersion: '2.0.0' }), conn('antigravity')]));
    fireEvent.click(primary('Get started'));
    for (const id of ['claude', 'codex', 'antigravity'] as const) {
      expect(within(row(id)).getByText('Found and signed in')).toBeTruthy();
      expect(within(row(id)).getByText('Connected')).toBeTruthy();
      expect(within(row(id)).queryByRole('button')).toBeNull();
    }
    expect((primary('Continue') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText('3 connected. You can add more later in Connections.')).toBeTruthy();
  });

  it('Sign in runs the shared connect action; Antigravity says Starting (can take a couple of minutes) until its link arrives', async () => {
    mocked.connect.mockResolvedValue(cs('antigravity', { phase: 'signing_in', step: 'Starting Antigravity…', lastOp: 'signin' }));
    const store = seeded([conn('claude'), signedOut('codex'), signedOut('antigravity')]);
    mount(store);
    fireEvent.click(primary('Get started'));
    fireEvent.click(within(row('antigravity')).getByRole('button', { name: /Sign in/ }));
    await waitFor(() => expect(within(row('antigravity')).getByText('Starting Antigravity…')).toBeTruthy());
    expect(mocked.connect).toHaveBeenCalledWith('antigravity', 'signin');
    expect(within(row('antigravity')).getByText('This can take a couple of minutes the first time.')).toBeTruthy();
    expect(within(row('antigravity')).getByRole('button', { name: /Cancel/ })).toBeTruthy();
    expect(screen.queryByText('Opened Google sign-in in your browser')).toBeNull();
    // The agent started and printed its link (it opens the browser itself): now the sign-in step and the toast.
    act(() => applyConnectEvent(store, cs('antigravity', { phase: 'signing_in', step: 'Finish signing in in your browser', signInUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1', lastOp: 'signin', updatedAt: new Date(Date.parse(store.getState().connect.antigravity!.updatedAt) + 1000).toISOString() })));
    expect(within(row('antigravity')).getByText('Finish signing in in your browser')).toBeTruthy();
    expect(within(row('antigravity')).queryByText('This can take a couple of minutes the first time.')).toBeNull();
    expect(await screen.findByText('Opened Google sign-in in your browser')).toBeTruthy();
    // Codex signing in does not get the Antigravity note.
    act(() => store.setState((s) => applyEvent(s, { type: 'connect.updated', state: cs('codex', { phase: 'signing_in' }) })));
    expect(within(row('codex')).queryByText('This can take a couple of minutes the first time.')).toBeNull();
  });

  it('an install in progress shows its step, progress and Cancel', () => {
    mount(seeded([conn('claude'), missing('codex'), missing('antigravity')], {
      connect: [cs('antigravity', { phase: 'installing', step: 'Downloading Antigravity…', progress: 0.4, lastOp: 'install' })],
    }));
    fireEvent.click(primary('Get started'));
    expect(within(row('antigravity')).getByText('Downloading Antigravity…')).toBeTruthy();
    expect(within(row('antigravity')).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('40');
    expect(within(row('antigravity')).getByText('This can take a couple of minutes the first time.')).toBeTruthy();
    expect(within(row('antigravity')).getByRole('button', { name: /Cancel/ })).toBeTruthy();
  });

  it('with nothing connected, the step focuses its heading (Continue is disabled)', () => {
    mount(seeded([signedOut('claude'), missing('codex'), missing('antigravity')]));
    fireEvent.click(primary('Get started'));
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Connect the agents you use' }));
    expect(screen.getByRole('group', { name: 'Connect the agents you use' }).getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByText('Step 1 of 5')).toBeTruthy();
  });

  it('Enter on the step advances with the primary button; Back returns', () => {
    mount(seeded([conn('claude')]));
    fireEvent.keyDown(dialog()!, { key: 'Enter' });
    expect(screen.getByRole('heading', { name: 'Connect the agents you use' })).toBeTruthy();
    expect(screen.getByText('Step 1 of 5')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('heading', { name: /All your coding agents/ })).toBeTruthy();
  });
});

describe('chats and notifications steps', () => {
  it('shows chats per connected provider and projects; Show in sidebar saves showChats at once', async () => {
    mocked.patchSettings.mockResolvedValue(settings({ showChats: { ...ON, codex: false } }));
    const store = seeded([conn('claude'), conn('codex'), missing('antigravity')], {
      history: [...hist('claude', 3), ...hist('codex', 2, '/w/beta')],
      projects: [project('/w/alpha', ['claude']), project('/w/beta', ['codex'])],
    });
    mount(store);
    fireEvent.click(primary('Get started'));
    fireEvent.click(primary('Continue'));
    expect(screen.getByRole('heading', { name: 'Bring in your chats' })).toBeTruthy();
    expect(document.querySelector('[data-found="antigravity"]')).toBeNull();
    await waitFor(() => expect(document.querySelector('[data-found="claude"] .n')?.textContent).toBe('3'));
    await waitFor(() => expect(document.querySelector('[data-found="codex"] .n')?.textContent).toBe('2'));
    expect(screen.getByText('FOUND IN 2 PROJECTS')).toBeTruthy();
    expect(screen.getByText(/We only read chat titles and project folders/)).toBeTruthy();

    fireEvent.click(screen.getByRole('switch', { name: 'Show Codex chats in the sidebar' }));
    await waitFor(() => expect(mocked.patchSettings).toHaveBeenCalledWith({ showChats: { codex: false } }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Show Codex chats in the sidebar' }).getAttribute('aria-checked')).toBe('false'));
    expect(mocked.patchSettings).not.toHaveBeenCalledWith(expect.objectContaining({ onboarded: true }));
  });

  it('off then on while the first save is in flight: the last click wins (final PATCH true, switch on)', async () => {
    const pending: ((v: Settings) => void)[] = [];
    mocked.patchSettings.mockImplementation(() => new Promise<Settings>((r) => pending.push(r)));
    mocked.history.mockImplementation(() => new Promise(() => {})); // the refetch never answers
    mocked.projects.mockImplementation(() => new Promise(() => {}));
    mount(seeded([conn('claude'), conn('codex')], { history: hist('codex', 2) }));
    fireEvent.click(primary('Get started'));
    fireEvent.click(primary('Continue'));
    const sw = () => screen.getByRole('switch', { name: 'Show Codex chats in the sidebar' });
    fireEvent.click(sw()); // off
    expect(sw().getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw()); // on, while "off" is saving
    expect(sw().getAttribute('aria-checked')).toBe('true');
    expect(mocked.patchSettings).toHaveBeenCalledTimes(1);
    await act(async () => { pending[0]!(settings({ showChats: { ...ON, codex: false } })); });
    await waitFor(() => expect(mocked.patchSettings).toHaveBeenCalledTimes(2));
    expect(mocked.patchSettings).toHaveBeenLastCalledWith({ showChats: { codex: true } });
    await act(async () => { pending[1]!(settings()); });
    await waitFor(() => expect(sw().getAttribute('aria-checked')).toBe('true'));
    expect(mocked.patchSettings).toHaveBeenCalledTimes(2);
  });

  it('a provider whose chats are hidden shows "—", not a partial count', () => {
    mount(seeded([conn('claude'), conn('codex')], { settings: settings({ showChats: { ...ON, codex: false } }), history: hist('claude', 3) }));
    fireEvent.click(primary('Get started'));
    fireEvent.click(primary('Continue'));
    expect(document.querySelector('[data-found="codex"] .n')?.textContent).toBe('—');
    expect(screen.getByRole('switch', { name: 'Show Codex chats in the sidebar' }).getAttribute('aria-checked')).toBe('false');
  });

  it('the notifications step uses the notifier prefs', () => {
    mount(seeded([conn('claude')]));
    fireEvent.click(primary('Get started'));
    fireEvent.click(primary('Continue'));
    fireEvent.click(primary('Continue'));
    fireEvent.click(primary('Continue'));
    expect(screen.getByRole('heading', { name: 'Know when an agent needs you' })).toBeTruthy();
    const sound = screen.getByRole('switch', { name: 'Sound' });
    expect(sound.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sound);
    expect(JSON.parse(localStorage.getItem('agent-kanban.notify') ?? '{}').sound).toBe(false);
    expect(screen.getByRole('button', { name: 'Play it' })).toBeTruthy();
    fireEvent.click(sound); // restore
  });
});

describe('home provider step (#40)', () => {
  it('picking a tile writes homeProvider; tiles are a radio group', async () => {
    mocked.patchSettings.mockResolvedValue(settings({ homeProvider: 'codex', skillSync: true }));
    mount(seeded([conn('claude'), conn('codex')]));
    fireEvent.click(primary('Get started'));
    fireEvent.click(primary('Continue'));
    fireEvent.click(primary('Continue'));
    expect(screen.getByRole('heading', { name: 'Which agent do you use most?' })).toBeTruthy();
    const group = screen.getByRole('radiogroup', { name: 'Home provider' });
    expect(within(group).getAllByRole('radio')).toHaveLength(2);
    fireEvent.click(within(group).getByRole('radio', { name: /Codex/ }));
    await waitFor(() => expect(mocked.patchSettings).toHaveBeenCalledWith({ homeProvider: 'codex' }));
    await waitFor(() => expect(within(group).getByRole('radio', { name: /Codex/ }).getAttribute('aria-checked')).toBe('true'));
  });
});

describe('notifications step hint (#6)', () => {
  const toNotifications = () => {
    fireEvent.click(primary('Get started'));
    fireEvent.click(primary('Continue'));
    fireEvent.click(primary('Continue'));
    fireEvent.click(primary('Continue'));
  };
  for (const [permission, shown] of [['default', true], ['denied', false], ['granted', false]] as const) {
    it(`"Windows will ask" shows only before the browser has asked (${permission})`, () => {
      vi.stubGlobal('Notification', { permission, requestPermission: async () => permission });
      try {
        mount(seeded([conn('claude')]));
        toNotifications();
        expect(screen.queryByText('Windows will ask to allow notifications.') !== null).toBe(shown);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  }
});

describe('finish', () => {
  const toReady = () => {
    fireEvent.click(primary('Get started'));
    fireEvent.click(primary('Continue'));
    fireEvent.click(primary('Continue'));
    fireEvent.click(primary('Continue'));
    fireEvent.click(primary('Continue'));
  };

  it('leaves hidden projects and their chats out of the summary', () => {
    const temp: Project = { ...project('/tmp/ak-claude-1', ['claude']), hidden: 'auto' };
    const store = seeded([conn('claude')], { history: [...hist('claude', 4), ...hist('claude', 3, '/tmp/ak-claude-1').map((h) => ({ ...h, sessionRef: `t${h.sessionRef}` }))], projects: [project('/w/alpha', ['claude']), temp] });
    mount(store);
    toReady();
    expect(screen.getByText('4 chats from 1 projects in the sidebar')).toBeTruthy();
  });

  it('summarises, writes onboarded: true, closes, and opens New chat', async () => {
    mocked.patchSettings.mockResolvedValue(settings({ onboarded: true }));
    let focusAtOpen: Element | null = null;
    const newChat = vi.fn(() => { focusAtOpen = document.activeElement; });
    setNewChatHandler(newChat);
    const store = seeded([conn('claude'), signedOut('codex'), missing('antigravity')], { history: hist('claude', 4), projects: [project('/w/alpha', ['claude'])] });
    const { container } = mount(store);
    toReady();
    expect(screen.getByRole('heading', { name: 'You’re set up' })).toBeTruthy();
    expect(screen.getByText('1 agent connected: Claude Code')).toBeTruthy();
    expect(screen.getByText('4 chats from 1 projects in the sidebar')).toBeTruthy();
    fireEvent.click(primary(/Start your first chat/));
    await waitFor(() => expect(mocked.patchSettings).toHaveBeenCalledWith({ onboarded: true }));
    await waitFor(() => expect(newChat).toHaveBeenCalled());
    expect(store.getState().settings?.onboarded).toBe(true);
    expect(container.inert).toBe(false);
    // Focus was put on the board before New chat opened, so closing New chat returns it there.
    expect(focusAtOpen).toBe(document.getElementById('main'));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(hasOpenLayer()).toBe(false);
  });

  it('Go to the board finishes and leaves focus on the board', async () => {
    mocked.patchSettings.mockResolvedValue(settings({ onboarded: true }));
    location.hash = '#/connections';
    mount(seeded([conn('claude')]));
    toReady();
    fireEvent.click(screen.getByRole('button', { name: 'Go to the board' }));
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById('main')));
    expect(location.hash).toBe('#/board');
    await waitFor(() => expect(dialog()).toBeNull());
  });

  it('the notifications line says what will reach the user: blocked desktop notifications are not called on', () => {
    vi.stubGlobal('Notification', { permission: 'denied', requestPermission: async () => 'denied' });
    try {
      setPrefs({ desktop: true, sound: true });
      mount(seeded([conn('claude')]));
      toReady();
      expect(screen.getByText('Sound on; desktop notifications are blocked in your browser')).toBeTruthy();
      expect(screen.queryByText(/^Notifications on/)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
      setPrefs({ desktop: false, sound: true });
    }
  });

  it('notificationsLine covers every combination', () => {
    expect(notificationsLine({ desktop: true, sound: true }, 'granted')).toBe('Notifications on, with sound');
    expect(notificationsLine({ desktop: true, sound: false }, 'granted')).toBe('Notifications on');
    expect(notificationsLine({ desktop: true, sound: true }, 'denied')).toBe('Sound on; desktop notifications are blocked in your browser');
    expect(notificationsLine({ desktop: false, sound: true }, 'unsupported')).toBe('Sound on; this browser can’t show desktop notifications');
    expect(notificationsLine({ desktop: false, sound: true }, 'default')).toBe('Sound on; desktop notifications off');
    expect(notificationsLine({ desktop: false, sound: true }, 'granted')).toBe('Sound on; desktop notifications off');
    expect(notificationsLine({ desktop: true, sound: false }, 'denied')).toBe('Notifications off. Turn them on from the bell any time');
    expect(notificationsLine({ desktop: false, sound: false }, 'granted')).toBe('Notifications off. Turn them on from the bell any time');
  });

  it('a failed write toasts the server text and stays on the last step', async () => {
    mocked.patchSettings.mockRejectedValue(new ApiError('Couldn’t save settings.', 500));
    const newChat = vi.fn();
    setNewChatHandler(newChat);
    const store = seeded([conn('claude')]);
    mount(store);
    toReady();
    fireEvent.click(screen.getByRole('button', { name: 'Go to the board' }));
    await waitFor(() => expect(screen.getByText('Couldn’t save settings.')).toBeTruthy());
    expect(dialog()).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'You’re set up' })).toBeTruthy();
    expect(store.getState().settings?.onboarded).toBe(false);
    expect(newChat).not.toHaveBeenCalled();
  });
});
