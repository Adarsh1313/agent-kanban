import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ConnectionHealth, Project, ProviderId, UsageReading } from '@agent-kanban/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/api/client.ts';
import { applySnapshot, initialState, type AppState } from '../src/state/reducer.ts';
import { createStore, StoreProvider, type Store } from '../src/state/store.ts';
import { openNewChat } from '../src/ui/actions.ts';
import { allowedProviders, findProject, NewChatDialog, resetModelsCache } from '../src/ui/newchat/NewChatDialog.tsx';
import { Toasts } from '../src/ui/primitives/toast.tsx';
import { Shell } from '../src/ui/shell/Shell.tsx';
import { chat } from './helpers.ts';

vi.mock('../src/api/client.ts', async (orig) => {
  const m = await orig<typeof import('../src/api/client.ts')>();
  return { ...m, api: { ...m.api, startChat: vi.fn(), models: vi.fn() } };
});

const mocked = api as unknown as { startChat: ReturnType<typeof vi.fn>; models: ReturnType<typeof vi.fn> };
const NOW = Date.parse('2026-10-23T12:00:00.000Z');

const conn = (provider: ProviderId, status: ConnectionHealth['status'] = 'connected'): ConnectionHealth => ({
  provider, installed: status !== 'not_installed', path: null, version: '1.0.0', latestVersion: null, updateAvailable: status === 'update_available',
  signedIn: status !== 'signed_out', processOk: true, status, message: null, checkedAt: '2026-10-23T11:00:00.000Z',
});
const project = (id: string, providers: ProviderId[], lastActivityAt = '2026-10-23T10:00:00.000Z'): Project => ({
  id, name: id.split('/').pop()!, path: id,
  providers: providers.map((provider) => ({ provider, chats: 1, lastUsedAt: lastActivityAt, lastModel: null })),
  columns: { running: 0, needs_you: 0, review: 0, done: 0 }, historyOnly: 0, lastActivityAt,
});
const reading = (provider: ProviderId, five: number, week: number): UsageReading => ({
  provider, status: 'ok', readAt: '2026-10-23T11:00:00.000Z',
  windows: [{ kind: 'five_hour', label: '5-hour', leftPct: five, resetsAt: null }, { kind: 'weekly', label: 'Weekly', leftPct: week, resetsAt: null }],
});

const PROJECTS = [project('/work/alpha', ['claude'], '2026-10-23T11:00:00.000Z'), project('/work/beta', ['claude', 'codex'])];

function seeded(over: { connections?: ConnectionHealth[]; projects?: Project[]; suggested?: ProviderId | null; usage?: UsageReading[] } = {}, extra: Partial<AppState> = {}): Store {
  const s = applySnapshot(initialState(), {
    chats: [],
    usage: over.usage ?? [reading('claude', 82, 64)],
    suggested: over.suggested ?? null,
    connections: over.connections ?? [conn('claude'), conn('codex'), conn('antigravity', 'signed_out')],
    history: [],
    projects: over.projects ?? PROJECTS,
  });
  return createStore({ ...s, now: NOW, ...extra });
}
const mount = (store: Store) => render(<StoreProvider store={store}><NewChatDialog /><Toasts /></StoreProvider>);
const dialog = () => document.querySelector<HTMLElement>('.dialog')!;
const promptBox = () => screen.getByRole('textbox', { name: 'Prompt' }) as HTMLTextAreaElement;
const chip = (name: RegExp) => within(dialog()).getByRole('button', { name });
const listbox = (label: string) => document.querySelector<HTMLElement>(`.popover[aria-label="${label}"]`)!;
const start = () => within(dialog()).getByRole('button', { name: /Start chat/ });
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

beforeEach(() => {
  mocked.startChat.mockReset();
  mocked.models.mockReset();
  mocked.models.mockResolvedValue({ claude: [{ id: 'opus', label: 'Opus', isDefault: true }, { id: 'sonnet', label: 'Sonnet', isDefault: false }], codex: [{ id: 'gpt-5', label: 'GPT-5', isDefault: true }], antigravity: [] });
  resetModelsCache();
});
afterEach(() => cleanup());

describe('allowedProviders', () => {
  it('a known project allows the connected providers that worked in it', () => {
    const s = seeded().getState();
    expect(allowedProviders(s, PROJECTS[0])).toEqual(['claude']);
    expect(allowedProviders(s, PROJECTS[1])).toEqual(['claude', 'codex']);
  });
  it('a new folder allows any connected provider, Antigravity included; update_available counts as connected', () => {
    const s = seeded({ connections: [conn('claude', 'update_available'), conn('codex', 'degraded'), conn('antigravity')] }).getState();
    expect(allowedProviders(s, undefined)).toEqual(['claude', 'antigravity']);
  });
});

describe('findProject', () => {
  it('matches a folder however it is spelled (the shared folderKey: case, slashes, trailing separator, UNC)', () => {
    const ps = [project('C:\\Work\\Alpha', ['claude']), project('\\\\server\\Share\\x', ['codex']), project('/work/beta', ['codex'])];
    expect(findProject(ps, 'c:/work/alpha/')?.id).toBe('C:\\Work\\Alpha');
    expect(findProject(ps, '\\\\SERVER\\share\\x\\')?.id).toBe('\\\\server\\Share\\x');
    expect(findProject(ps, '/work/beta/')?.id).toBe('/work/beta');
    expect(findProject(ps, '/Work/beta')).toBeUndefined();
  });
});

describe('New chat dialog', () => {
  it('opens on the latest project; the provider picker disables providers that have not worked there or are not connected', async () => {
    mount(seeded());
    act(() => openNewChat());
    expect(dialog().dataset.state).toBe('open');
    expect(chip(/^Project: alpha$/)).toBeTruthy();
    fireEvent.click(chip(/^Provider:/));
    const pop = listbox('Provider');
    const row = (name: string) => within(pop).getByRole('option', { name: new RegExp(name) });
    expect(row('Claude Code').getAttribute('aria-disabled')).toBeNull();
    expect(row('Claude Code').getAttribute('aria-selected')).toBe('true');
    expect(within(row('Claude Code')).getByText('82% of 5-hour · 64% of weekly left')).toBeTruthy();
    expect(row('Codex').getAttribute('aria-disabled')).toBe('true');
    expect(within(row('Codex')).getByText('Hasn’t worked on alpha yet')).toBeTruthy();
    expect(row('Antigravity').getAttribute('aria-disabled')).toBe('true');
    expect(within(row('Antigravity')).getByText('Not signed in')).toBeTruthy();
    // A disabled row does nothing.
    fireEvent.click(row('Codex'));
    expect(chip(/^Provider: Claude Code$/)).toBeTruthy();
    expect(within(dialog()).getByText(/alpha has been worked on with Claude Code/)).toBeTruthy();
  });

  it('openNewChat({ cwd }) preselects that folder and allows its providers; usage with no reading shows —', () => {
    mount(seeded({ suggested: 'codex' }));
    act(() => openNewChat({ cwd: '/work/beta' }));
    expect(chip(/^Project: beta$/)).toBeTruthy();
    expect(chip(/^Provider: Codex/).textContent).toContain('Suggested');
    expect(within(dialog()).getByText('Codex: — of 5-hour · — of weekly left')).toBeTruthy();
    fireEvent.click(chip(/^Provider:/));
    const codex = within(listbox('Provider')).getByRole('option', { name: /Codex/ });
    expect(codex.getAttribute('aria-disabled')).toBeNull();
  });

  it('falls back to the first allowed provider when the server suggestion is null or not allowed', () => {
    mount(seeded({ suggested: 'codex' }));
    act(() => openNewChat({ cwd: '/work/alpha' }));
    expect(chip(/^Provider: Claude Code$/)).toBeTruthy();
    expect(chip(/^Provider:/).textContent).not.toContain('Suggested');
    cleanup();
    mount(seeded({ suggested: null }));
    act(() => openNewChat({ cwd: '/work/beta' }));
    expect(chip(/^Provider: Claude Code$/)).toBeTruthy();
  });

  it('a provider preset (a project page’s "New Codex chat") is preselected when allowed, else ignored', () => {
    mount(seeded({ suggested: 'claude' }));
    act(() => openNewChat({ cwd: '/work/beta', provider: 'codex' }));
    expect(chip(/^Project: beta$/)).toBeTruthy();
    expect(chip(/^Provider: Codex$/)).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    // Codex hasn't worked in alpha, and Antigravity isn't connected: the usual pick stands.
    act(() => openNewChat({ cwd: '/work/alpha', provider: 'codex' }));
    expect(chip(/^Provider: Claude Code/)).toBeTruthy();
    act(() => openNewChat({ cwd: '/work/beta', provider: 'antigravity' }));
    expect(chip(/^Provider: Claude Code/)).toBeTruthy();
  });

  it('an empty folder (Add a folder) opens on the folder path field', () => {
    mount(seeded());
    act(() => openNewChat({ cwd: '' }));
    expect(chip(/^Project: Another folder$/)).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Folder path' }) as HTMLInputElement).value).toBe('');
  });

  it('switching project keeps an allowed provider and drops one that is not', () => {
    mount(seeded());
    act(() => openNewChat({ cwd: '/work/beta' }));
    fireEvent.click(chip(/^Provider:/));
    fireEvent.click(within(listbox('Provider')).getByRole('option', { name: /Codex/ }));
    expect(chip(/^Provider: Codex/)).toBeTruthy();
    fireEvent.click(chip(/^Project:/));
    fireEvent.click(within(listbox('Project')).getByRole('option', { name: /alpha/ }));
    expect(chip(/^Project: alpha$/)).toBeTruthy();
    expect(chip(/^Provider: Claude Code$/)).toBeTruthy();
  });

  it('start sends { provider, cwd, prompt } with Default omitted, and closes on success', async () => {
    mocked.startChat.mockResolvedValue(chat());
    const store = seeded();
    mount(store);
    act(() => openNewChat());
    fireEvent.change(promptBox(), { target: { value: '  Fix the build  ' } });
    fireEvent.click(start());
    await flush();
    expect(mocked.startChat).toHaveBeenCalledWith({ provider: 'claude', cwd: '/work/alpha', prompt: 'Fix the build' });
    expect(dialog().dataset.state).toBe('closed');
    expect(store.getState().ui.openChatId).toBeNull();
  });

  it('a picked model is sent; changing provider resets it to Default', async () => {
    mocked.startChat.mockResolvedValue(chat());
    mount(seeded());
    act(() => openNewChat({ cwd: '/work/beta' }));
    await flush();
    fireEvent.click(chip(/^Model: Default$/));
    const pop = listbox('Model');
    const options = within(pop).getAllByRole('option');
    expect(options.map((o) => o.querySelector('b')!.textContent)).toEqual(['Default', 'Opus', 'Sonnet']);
    fireEvent.click(within(pop).getByRole('option', { name: /^Sonnet/ }));
    expect(chip(/^Model: Sonnet$/)).toBeTruthy();
    fireEvent.click(chip(/^Provider:/));
    fireEvent.click(within(listbox('Provider')).getByRole('option', { name: /Codex/ }));
    expect(chip(/^Model: Default$/)).toBeTruthy();
    fireEvent.click(chip(/^Provider:/));
    fireEvent.click(within(listbox('Provider')).getByRole('option', { name: /Claude Code/ }));
    // Back on Claude Code the earlier pick does not come back.
    expect(chip(/^Model: Default$/)).toBeTruthy();
    fireEvent.click(chip(/^Model:/));
    fireEvent.click(within(listbox('Model')).getByRole('option', { name: /^Opus/ }));
    fireEvent.change(promptBox(), { target: { value: 'Go' } });
    fireEvent.keyDown(promptBox(), { key: 'Enter', ctrlKey: true });
    await flush();
    expect(mocked.startChat).toHaveBeenCalledWith({ provider: 'claude', cwd: '/work/beta', prompt: 'Go', model: 'opus' });
  });

  it('Ctrl+Enter during IME composition does not start', async () => {
    mount(seeded());
    act(() => openNewChat());
    fireEvent.change(promptBox(), { target: { value: 'Go' } });
    fireEvent.keyDown(promptBox(), { key: 'Enter', ctrlKey: true, isComposing: true });
    await flush();
    expect(mocked.startChat).not.toHaveBeenCalled();
    fireEvent.keyDown(promptBox(), { key: 'Enter', metaKey: true });
    await flush();
    expect(mocked.startChat).toHaveBeenCalledTimes(1);
  });

  it('an empty prompt does not start: it marks the field and keeps focus there', async () => {
    mount(seeded());
    act(() => openNewChat());
    fireEvent.click(start());
    await flush();
    expect(mocked.startChat).not.toHaveBeenCalled();
    expect(promptBox().getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(promptBox());
    expect(within(dialog()).getByText('Write what the agent should do first.')).toBeTruthy();
  });

  it('the empty-prompt shake is skipped with prefers-reduced-motion', async () => {
    const animate = vi.fn();
    (HTMLElement.prototype as unknown as { animate: unknown }).animate = animate;
    try {
      mount(seeded());
      act(() => openNewChat());
      fireEvent.click(start());
      expect(animate).toHaveBeenCalledTimes(1);
      vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {} }));
      fireEvent.click(start());
      expect(animate).toHaveBeenCalledTimes(1);
      expect(promptBox().className).toBe('invalid');
    } finally {
      delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
      vi.unstubAllGlobals();
    }
  });

  it('Start is disabled while the request is in flight (no double submit)', async () => {
    let resolve!: (c: unknown) => void;
    mocked.startChat.mockReturnValue(new Promise((r) => { resolve = r; }));
    mount(seeded());
    act(() => openNewChat());
    fireEvent.change(promptBox(), { target: { value: 'Go' } });
    fireEvent.click(start());
    await flush();
    expect((within(dialog()).getByRole('button', { name: 'Starting…' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(promptBox(), { key: 'Enter', ctrlKey: true });
    expect(mocked.startChat).toHaveBeenCalledTimes(1);
    await act(async () => { resolve(chat()); });
    expect(dialog().dataset.state).toBe('closed');
  });

  it("Choose another folder…: the server's 400 shows inline under the path field and nothing else changes", async () => {
    mocked.startChat.mockRejectedValue(new ApiError("That folder doesn't exist.", 400));
    mount(seeded({ connections: [conn('claude'), conn('codex'), conn('antigravity', 'not_installed')] }));
    act(() => openNewChat());
    fireEvent.click(chip(/^Project:/));
    fireEvent.click(within(listbox('Project')).getByRole('option', { name: /Choose another folder/ }));
    const input = screen.getByRole('textbox', { name: 'Folder path' }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '/nope/new-thing' } });
    // A new folder allows any connected provider.
    fireEvent.click(chip(/^Provider:/));
    const pop = listbox('Provider');
    expect(within(pop).getByRole('option', { name: /Codex/ }).getAttribute('aria-disabled')).toBeNull();
    expect(within(within(pop).getByRole('option', { name: /Antigravity/ })).getByText('Not installed')).toBeTruthy();
    fireEvent.click(within(pop).getByRole('option', { name: /Codex/ }));
    fireEvent.change(promptBox(), { target: { value: 'Hello' } });
    fireEvent.click(start());
    await flush();
    expect(mocked.startChat).toHaveBeenCalledWith({ provider: 'codex', cwd: '/nope/new-thing', prompt: 'Hello' });
    expect(screen.getByRole('alert').textContent).toBe("That folder doesn't exist.");
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(dialog().dataset.state).toBe('open');
    expect(promptBox().value).toBe('Hello');
    expect(document.querySelector('.toast')).toBeNull();
    // Typing clears it.
    fireEvent.change(input, { target: { value: '/nope/other' } });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a cwd that is not a known project opens the path field prefilled', () => {
    mount(seeded());
    act(() => openNewChat({ cwd: '/elsewhere/gamma' }));
    expect((screen.getByRole('textbox', { name: 'Folder path' }) as HTMLInputElement).value).toBe('/elsewhere/gamma');
    expect(chip(/^Project: gamma$/)).toBeTruthy();
  });

  it('any other error toasts the server text and keeps the dialog and the prompt', async () => {
    mocked.startChat.mockRejectedValue(new ApiError('Unknown provider. Use claude, codex or antigravity.', 400));
    mount(seeded());
    act(() => openNewChat());
    fireEvent.change(promptBox(), { target: { value: 'Keep me' } });
    fireEvent.click(start());
    await waitFor(() => expect(document.querySelector('.toast')?.textContent).toContain('Unknown provider. Use claude, codex or antigravity.'));
    expect(dialog().dataset.state).toBe('open');
    expect(promptBox().value).toBe('Keep me');
    expect((start() as HTMLButtonElement).disabled).toBe(false);
  });

  it('with no connected provider, Start is disabled and the note says why', () => {
    mount(seeded({ connections: [conn('claude', 'signed_out')] }));
    act(() => openNewChat());
    expect((start() as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog()).getByText(/None of your connected providers has worked on alpha yet/)).toBeTruthy();
  });
});

describe('New chat: keyboard', () => {
  it('N opens the dialog; Escape closes a picker first, then the dialog', () => {
    render(<StoreProvider store={seeded()}><Shell /></StoreProvider>);
    expect(dialog().dataset.state).toBe('closed');
    fireEvent.keyDown(document.body, { key: 'n' });
    expect(dialog().dataset.state).toBe('open');
    expect(document.activeElement).toBe(promptBox());
    // Typing N in the prompt does not reopen or anything else.
    fireEvent.keyDown(promptBox(), { key: 'n' });
    fireEvent.click(chip(/^Provider:/));
    expect(listbox('Provider').dataset.state).toBe('open');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(listbox('Provider').dataset.state).toBe('closed');
    expect(dialog().dataset.state).toBe('open');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(dialog().dataset.state).toBe('closed');
  });
});

describe('New chat: loading and odd data', () => {
  it('opened before the projects load, it picks the latest project when they arrive', () => {
    const store = seeded({ projects: [] });
    mount(store);
    act(() => openNewChat());
    expect(screen.getByRole('textbox', { name: 'Folder path' })).toBeTruthy();
    act(() => store.setState((s) => ({ ...s, projects: PROJECTS })));
    expect(chip(/^Project: alpha$/)).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Folder path' })).toBeNull();
  });

  it('a project with no folder is never offered or matched by an empty path', () => {
    mount(seeded({ projects: [project('', ['codex'], '2026-10-23T11:59:00.000Z')] }));
    act(() => openNewChat());
    expect(screen.getByRole('textbox', { name: 'Folder path' })).toBeTruthy();
    expect(within(dialog()).queryByText(/has been worked on/)).toBeNull();
    fireEvent.click(chip(/^Project:/));
    expect(within(listbox('Project')).getAllByRole('option').length).toBe(1);
  });

  it('the model the server calls "default" is not listed twice', async () => {
    mocked.models.mockResolvedValue({ claude: [{ id: 'default', label: 'Default (recommended)', isDefault: true }, { id: 'opus', label: 'Opus', isDefault: false }], codex: [], antigravity: [] });
    mount(seeded());
    act(() => openNewChat());
    await flush();
    fireEvent.click(chip(/^Model:/));
    const names = within(listbox('Model')).getAllByRole('option').map((o) => o.querySelector('b')!.textContent);
    expect(names).toEqual(['Default', 'Opus']);
    expect(within(listbox('Model')).getByText("Uses Claude Code's own default")).toBeTruthy();
  });
});

describe('New chat: fix round 1', () => {
  it('a connected Antigravity can be picked for a new folder; status text shows for providers that are not connected', async () => {
    mocked.startChat.mockResolvedValue({ id: 'c9' } as never);
    mount(seeded({ connections: [conn('claude'), conn('codex', 'not_installed'), conn('antigravity')] }));
    act(() => openNewChat({ cwd: '/elsewhere/new' }));
    fireEvent.click(chip(/^Provider:/));
    const pop = listbox('Provider');
    const ag = within(pop).getByRole('option', { name: /Antigravity/ });
    expect(ag.getAttribute('aria-disabled')).toBeNull();
    expect(within(within(pop).getByRole('option', { name: /Codex/ })).getByText('Not installed')).toBeTruthy();
    fireEvent.click(ag);
    expect(chip(/^Provider: Antigravity$/)).toBeTruthy();
    fireEvent.change(promptBox(), { target: { value: 'Go' } });
    fireEvent.click(start());
    await flush();
    expect(mocked.startChat).toHaveBeenCalledWith(expect.objectContaining({ provider: 'antigravity', cwd: '/elsewhere/new', prompt: 'Go' }));
  });

  it('Antigravity: the footer says its limits are unavailable, and while it starts that it can take a couple of minutes', async () => {
    let resolve!: (c: unknown) => void;
    mocked.startChat.mockReturnValue(new Promise((r) => { resolve = r; }));
    const unavailable: UsageReading = { provider: 'antigravity', status: 'unavailable', readAt: '2026-10-23T11:00:00.000Z', windows: [] };
    mount(seeded({ connections: [conn('antigravity')], usage: [unavailable] }));
    act(() => openNewChat({ cwd: '/elsewhere/new' }));
    const hint = () => dialog().querySelector('.dlg-hint')!.textContent;
    expect(hint()).toBe('Antigravity: Limits unavailable');
    fireEvent.change(promptBox(), { target: { value: 'Go' } });
    fireEvent.click(start());
    await flush();
    expect(hint()).toBe('Starting Antigravity… This can take a couple of minutes the first time.');
    await act(async () => { resolve(chat()); });
  });

  it('when only Antigravity is connected, a new chat starts on it', async () => {
    mocked.startChat.mockResolvedValue({ id: 'c9' } as never);
    mount(seeded({ connections: [conn('antigravity')] }));
    act(() => openNewChat({ cwd: '/elsewhere/new' }));
    expect(chip(/^Provider: Antigravity$/)).toBeTruthy();
    expect(within(dialog()).queryByText(/aren't supported yet/)).toBeNull();
    fireEvent.change(promptBox(), { target: { value: 'Go' } });
    fireEvent.click(start());
    await flush();
    expect(mocked.startChat).toHaveBeenCalledWith(expect.objectContaining({ provider: 'antigravity', cwd: '/elsewhere/new', prompt: 'Go' }));
  });

  it("a known project's missing folder switches to the path field, prefilled, with the error inline and the prompt kept", async () => {
    mocked.startChat.mockRejectedValue(new ApiError("That folder doesn't exist.", 400));
    mount(seeded());
    act(() => openNewChat({ cwd: '/work/alpha' }));
    fireEvent.change(promptBox(), { target: { value: 'Keep' } });
    fireEvent.click(start());
    await flush();
    const input = screen.getByRole('textbox', { name: 'Folder path' }) as HTMLInputElement;
    expect(input.value).toBe('/work/alpha');
    expect(screen.getByRole('alert').textContent).toBe("That folder doesn't exist.");
    expect(document.activeElement).toBe(input);
    expect(promptBox().value).toBe('Keep');
    expect(document.querySelector('.toasts')?.textContent ?? '').not.toContain("That folder doesn't exist.");
  });

  it('while starting the button reads Starting… with aria-busy; text typed meanwhile survives the late success', async () => {
    let resolve!: (c: unknown) => void;
    mocked.startChat.mockReturnValue(new Promise((r) => { resolve = r; }));
    mount(seeded());
    act(() => openNewChat());
    fireEvent.change(promptBox(), { target: { value: 'First' } });
    fireEvent.click(start());
    await flush();
    const btn = within(dialog()).getByRole('button', { name: 'Starting…' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('aria-busy')).toBe('true');
    fireEvent.change(promptBox(), { target: { value: 'Second thought' } });
    await act(async () => { resolve(chat()); });
    expect(dialog().dataset.state).toBe('closed');
    expect(promptBox().value).toBe('Second thought');
  });

  it('a late success after the dialog was closed and opened again does not close or clear the new one', async () => {
    let resolve!: (c: unknown) => void;
    mocked.startChat.mockReturnValue(new Promise((r) => { resolve = r; }));
    mount(seeded());
    act(() => openNewChat());
    fireEvent.change(promptBox(), { target: { value: 'First' } });
    fireEvent.click(start());
    await flush();
    fireEvent.keyDown(document, { key: 'Escape' });
    act(() => openNewChat());
    await act(async () => { resolve(chat()); });
    expect(dialog().dataset.state).toBe('open');
  });

  it('pickers focus the selected option; arrows skip disabled rows, Home/End jump; labels are presentation', () => {
    mount(seeded({ connections: [conn('claude'), conn('codex'), conn('antigravity', 'signed_out')] }));
    act(() => openNewChat({ cwd: '/elsewhere/new' }));
    fireEvent.click(chip(/^Provider:/));
    const pop = listbox('Provider');
    const opt = (n: RegExp) => within(pop).getByRole('option', { name: n });
    expect(document.activeElement).toBe(opt(/Claude Code/));
    expect(pop.querySelector('.menu-label')!.getAttribute('role')).toBe('presentation');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(opt(/Codex/));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(opt(/Claude Code/)); // Antigravity (not signed in) is skipped; wraps
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(document.activeElement).toBe(opt(/Codex/));
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(document.activeElement).toBe(opt(/Claude Code/));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(opt(/Codex/));
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(chip(/^Project:/));
    expect(within(listbox('Project')).getByRole('option', { name: /Choose another folder/ })).toBe(document.activeElement);
    expect(listbox('Project').querySelector('.menu-sep')!.getAttribute('role')).toBe('presentation');
  });

  it('models are fetched again when the connections change or the chosen provider had none', async () => {
    mocked.models.mockResolvedValue({ claude: [], codex: [], antigravity: [] });
    const store = seeded();
    mount(store);
    act(() => openNewChat());
    await flush();
    // Claude's list came back empty, so the next opening asks again.
    fireEvent.keyDown(document, { key: 'Escape' });
    act(() => openNewChat());
    await flush();
    expect(mocked.models).toHaveBeenCalledTimes(2);
    mocked.models.mockResolvedValue({ claude: [{ id: 'opus', label: 'Opus', isDefault: false }], codex: [], antigravity: [] });
    act(() => store.setState((s) => ({ ...s, connections: { ...s.connections, codex: conn('codex', 'signed_out') } })));
    await flush();
    expect(mocked.models).toHaveBeenCalledTimes(3);
    fireEvent.click(chip(/^Model:/));
    expect(within(listbox('Model')).getByRole('option', { name: /^Opus/ })).toBeTruthy();
    // A provider with models is not refetched on the next opening.
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.keyDown(document, { key: 'Escape' });
    act(() => openNewChat());
    await flush();
    expect(mocked.models).toHaveBeenCalledTimes(3);
  });
});
