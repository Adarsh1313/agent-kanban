import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ConnectionHealth, ProviderId, UsageReading, UsageWindow } from '@agent-kanban/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/api/client.ts';
import { applyEvent, applySnapshot, initialState, type AppState } from '../src/state/reducer.ts';
import { createStore, StoreProvider, type Store } from '../src/state/store.ts';
import { Toasts } from '../src/ui/primitives/toast.tsx';
import { TopBar } from '../src/ui/shell/TopBar.tsx';
import { chipPercent, levelOf, resetText, updatedText } from '../src/ui/usage/model.ts';

vi.mock('../src/api/client.ts', async (orig) => {
  const m = await orig<typeof import('../src/api/client.ts')>();
  return { ...m, api: { ...m.api, refreshUsage: vi.fn() } };
});
const mocked = api as unknown as { refreshUsage: ReturnType<typeof vi.fn> };

// Local wall-clock times, so "Resets 2:40 pm" does not depend on the machine's time zone.
const NOW = new Date(2026, 9, 23, 12, 0).getTime();
const iso = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo, d, h, mi).toISOString();
const READ_AT = new Date(NOW - 10 * 60_000).toISOString();

const conn = (provider: ProviderId, installed = true): ConnectionHealth => ({
  provider, installed, path: null, version: '1.0.0', latestVersion: null, updateAvailable: false,
  signedIn: true, processOk: true, status: installed ? 'connected' : 'not_installed', message: null, checkedAt: READ_AT,
});
const win = (kind: UsageWindow['kind'], leftPct: number, resetsAt: string | null = null, label = kind === 'five_hour' ? '5-hour' : kind === 'weekly' ? 'Weekly' : 'Model'): UsageWindow =>
  ({ kind, label, leftPct, resetsAt });
const reading = (provider: ProviderId, five: number, week: number, over: Partial<UsageReading> = {}): UsageReading => ({
  provider, status: 'ok', readAt: READ_AT,
  windows: [win('five_hour', five, iso(2026, 9, 23, 14, 40)), win('weekly', week, iso(2026, 9, 29, 9, 0))],
  ...over,
});

function seeded(usage: UsageReading[], opts: { connections?: ConnectionHealth[]; suggested?: ProviderId | null } = {}, extra: Partial<AppState> = {}): Store {
  const s = applySnapshot(initialState(), {
    chats: [], usage, suggested: opts.suggested ?? null,
    connections: opts.connections ?? [conn('claude'), conn('codex'), conn('antigravity')], history: [], projects: [],
  });
  return createStore({ ...s, now: NOW, ...extra });
}
const mount = (store: Store) => render(<StoreProvider store={store}><TopBar /><Toasts /></StoreProvider>);
const area = () => document.querySelector<HTMLElement>('.usage-area')!;
const chips = () => [...area().querySelectorAll<HTMLButtonElement>('.usage-chip')];
const pop = () => document.querySelector<HTMLElement>('.popover.usage-pop')!;
const block = (id: ProviderId) => pop().querySelector<HTMLElement>(`.prov-block[data-provider="${id}"]`)!;

beforeEach(() => { mocked.refreshUsage.mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('usage helpers', () => {
  it('levels: under 25 % amber (low), under 5 % red (out)', () => {
    expect([levelOf(25), levelOf(24.9), levelOf(5), levelOf(4)]).toEqual(['ok', 'low', 'low', 'out']);
  });
  it("a chip's number is the lower of 5-hour and weekly", () => {
    expect(chipPercent(reading('claude', 82, 64))).toBe(64);
    expect(chipPercent(reading('claude', 12, 64))).toBe(12);
    expect(chipPercent(undefined)).toBeNull();
  });
  it('reset times: clock today, weekday within the week, date further out', () => {
    expect(resetText(win('weekly', 50, iso(2026, 9, 23, 14, 40)), NOW)).toBe('Resets 2:40 pm');
    expect(resetText(win('weekly', 50, iso(2026, 9, 26, 9, 0)), NOW)).toBe('Resets Mon 9:00 am');
    // 6.5 days away is still a weekday and time; 7 days or more is a date.
    expect(resetText(win('weekly', 50, iso(2026, 9, 30, 0, 0)), NOW)).toBe('Resets Fri 12:00 am');
    expect(resetText(win('weekly', 50, iso(2026, 9, 30, 12, 0)), NOW)).toBe('Resets Oct 30');
    expect(resetText(win('weekly', 50, iso(2026, 10, 21, 9, 0)), NOW)).toBe('Resets Nov 21');
    expect(resetText(win('weekly', 50, null), NOW)).toBeNull();
  });
  it('"Updated" text is relative to now from the newest reading', () => {
    expect(updatedText([reading('claude', 1, 1, { readAt: new Date(NOW).toISOString() })], NOW)).toBe('Updated just now');
    expect(updatedText([reading('claude', 1, 1)], NOW)).toBe('Updated 10 min ago');
    expect(updatedText([], NOW)).toBeNull();
  });
});

describe('usage chips', () => {
  it('one chip per installed provider, with the lower percent, two meters and an accessible name', () => {
    mount(seeded([reading('claude', 82, 64), reading('codex', 20, 70), reading('antigravity', 3, 90)], { connections: [conn('claude'), conn('codex'), conn('antigravity', false)] }));
    expect(chips().map((c) => c.dataset.prov)).toEqual(['claude', 'codex']);
    const claude = screen.getByRole('button', { name: 'Claude Code: 82% of 5-hour left, 64% of weekly left' });
    expect(claude.querySelector('.pct')!.textContent).toBe('64%');
    const bars = [...claude.querySelectorAll<HTMLElement>('.minimeter i')];
    expect(bars.map((b) => b.style.getPropertyValue('--left'))).toEqual(['0.82', '0.64']);
    expect(bars.map((b) => b.dataset.level)).toEqual(['ok', 'ok']);
    const codex = screen.getByRole('button', { name: /^Codex:/ });
    expect(codex.querySelector('.pct')!.textContent).toBe('20%');
    expect([...codex.querySelectorAll<HTMLElement>('.minimeter i')].map((b) => b.dataset.level)).toEqual(['low', 'ok']);
  });

  it('red under 5 %', () => {
    mount(seeded([reading('claude', 4, 50)], { connections: [conn('claude')] }));
    expect(chips()[0]!.querySelector<HTMLElement>('.minimeter i')!.dataset.level).toBe('out');
  });

  it('a signed-out provider shows a dimmed chip that says "Not signed in", and its message in the popover', () => {
    mount(seeded([reading('codex', 0, 0, { status: 'signed_out', windows: [], message: 'Sign in to Codex to see its limits.' })], { connections: [conn('codex')] }));
    const chip = screen.getByRole('button', { name: 'Codex: Not signed in' });
    expect(chip.hasAttribute('data-dim')).toBe(true);
    expect(chip.textContent).toContain('Not signed in');
    fireEvent.click(chip);
    expect(within(block('codex')).getByText('Sign in to Codex to see its limits.')).toBeTruthy();
    expect(within(block('codex')).getByText('Not signed in')).toBeTruthy();
  });

  it('an unavailable provider shows "Limits unavailable" and its message', () => {
    mount(seeded([reading('antigravity', 0, 0, { status: 'unavailable', windows: [], message: "Antigravity didn't report its limits." })], { connections: [conn('antigravity')] }));
    const chip = screen.getByRole('button', { name: 'Antigravity: Limits unavailable' });
    fireEvent.click(chip);
    expect(within(block('antigravity')).getByText("Antigravity didn't report its limits.")).toBeTruthy();
    expect(block('antigravity').querySelector('.meter')).toBeNull();
  });

  it('an error reading keeps the last numbers, dimmed, with the server message', () => {
    const store = seeded([reading('claude', 82, 64)], { connections: [conn('claude')] });
    mount(store);
    // The server normally carries the last windows; when it sends none, the store keeps the ones it had.
    act(() => store.setState((s) => applyEvent(s, { type: 'usage.updated', reading: { provider: 'claude', status: 'error', windows: [], readAt: new Date(NOW).toISOString(), message: "Couldn't read Claude Code usage. Showing the last numbers we had." } })));
    const chip = chips()[0]!;
    expect(chip.hasAttribute('data-dim')).toBe(true);
    expect(chip.querySelector('.pct')!.textContent).toBe('64%');
    fireEvent.click(chip);
    const b = block('claude');
    expect(b.dataset.status).toBe('error');
    expect(within(b).getByText("Couldn't read Claude Code usage. Showing the last numbers we had.")).toBeTruthy();
    expect(within(b).getAllByRole('meter').map((m) => m.getAttribute('aria-valuenow'))).toEqual(['82', '64']);
  });
});

describe('usage popover', () => {
  it('shows 5-hour and weekly with resets, "Most room", and a By model disclosure', () => {
    const r = reading('claude', 82, 64);
    r.windows.push(win('model', 34, iso(2026, 9, 29, 9, 0), 'Opus · weekly'), win('model', 61, null, 'Sonnet · weekly'));
    mount(seeded([r, reading('codex', 30, 18)], { suggested: 'claude', connections: [conn('claude'), conn('codex')] }));
    fireEvent.click(chips()[0]!);
    expect(pop().dataset.state).toBe('open');
    expect(chips()[0]!.getAttribute('aria-expanded')).toBe('true');
    const b = block('claude');
    expect(within(b).getByText('Most room')).toBeTruthy();
    expect(within(block('codex')).queryByText('Most room')).toBeNull();
    expect(within(b).getByText('Resets 2:40 pm')).toBeTruthy();
    expect(within(b).getAllByText('Resets Thu 9:00 am')).toHaveLength(2); // weekly and Opus
    const five = within(b).getByRole('meter', { name: '5-hour left' });
    expect(five.getAttribute('aria-valuenow')).toBe('82');
    expect(five.querySelector<HTMLElement>('.fill')!.style.getPropertyValue('--left')).toBe('0.82');
    const toggle = within(b).getByRole('button', { name: 'By model' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(b.querySelector('.collapsible')!.classList.contains('closed')).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(b.querySelector('.collapsible')!.classList.contains('closed')).toBe(false);
    expect(within(b).getByText('Opus · weekly')).toBeTruthy();
    expect(within(block('codex')).queryByRole('button', { name: 'By model' })).toBeNull();
    expect(within(pop()).getByText('Updated 10 min ago')).toBeTruthy();
  });

  it('Refresh: disabled with "Checking…" while in flight, then applies the readings and says "Updated just now"', async () => {
    let resolve!: (v: unknown) => void;
    mocked.refreshUsage.mockReturnValue(new Promise((r) => { resolve = r; }));
    const store = seeded([reading('claude', 82, 64)], { connections: [conn('claude')] });
    mount(store);
    fireEvent.click(chips()[0]!);
    const btn = within(pop()).getByRole('button', { name: 'Refresh' }) as HTMLButtonElement;
    fireEvent.click(btn);
    expect(btn.disabled).toBe(true);
    expect(btn.querySelector('.icon')!.classList.contains('spinning')).toBe(true);
    expect(within(pop()).getByText('Checking…')).toBeTruthy();
    fireEvent.click(btn);
    expect(mocked.refreshUsage).toHaveBeenCalledTimes(1);
    await act(async () => { resolve({ readings: [reading('claude', 50, 40, { readAt: new Date(NOW).toISOString() })], suggested: 'claude' }); });
    await waitFor(() => expect(btn.disabled).toBe(false));
    expect(within(pop()).getByText('Updated just now')).toBeTruthy();
    expect(store.getState().usage.claude!.windows[0]!.leftPct).toBe(50);
    expect(store.getState().suggested).toBe('claude');
    expect(chips()[0]!.querySelector('.pct')!.textContent).toBe('40%');
  });

  it('a failed refresh toasts the server text and keeps the numbers', async () => {
    mocked.refreshUsage.mockRejectedValue(new ApiError('Usage is being read already.', 409));
    const store = seeded([reading('claude', 82, 64)], { connections: [conn('claude')] });
    mount(store);
    fireEvent.click(chips()[0]!);
    const btn = within(pop()).getByRole('button', { name: 'Refresh' }) as HTMLButtonElement;
    await act(async () => { fireEvent.click(btn); });
    await waitFor(() => expect(screen.getByText('Usage is being read already.')).toBeTruthy());
    expect(btn.disabled).toBe(false);
    expect(store.getState().usage.claude!.windows[0]!.leftPct).toBe(82);
    expect(chips()[0]!.querySelector('.pct')!.textContent).toBe('64%');
    expect(within(pop()).getByText('Updated 10 min ago')).toBeTruthy();
  });

  it("closes when its chip's provider disappears", () => {
    const store = seeded([reading('claude', 82, 64), reading('codex', 30, 18)], { connections: [conn('claude'), conn('codex')] });
    mount(store);
    fireEvent.click(chips()[1]!);
    expect(pop().dataset.state).toBe('open');
    act(() => store.setState((s) => ({ ...s, connections: { ...s.connections, codex: conn('codex', false) } })));
    expect(chips().map((c) => c.dataset.prov)).toEqual(['claude']);
    expect(pop().dataset.state).toBe('closed');
  });

  it('a refresh answered after a newer usage event does not overwrite it', () => {
    const store = seeded([reading('claude', 82, 64, { readAt: new Date(NOW).toISOString() })]);
    const older = applyEvent(store.getState(), { type: 'usage.updated', reading: reading('claude', 10, 10) });
    expect(older.usage.claude!.windows[0]!.leftPct).toBe(82);
  });
});

describe('usage focus', () => {
  const focusedOn = (over: Partial<AppState['ui']>) => {
    const store = seeded([reading('claude', 82, 64), reading('codex', 30, 18)], { connections: [conn('claude'), conn('codex')] });
    store.setState((s) => ({ ...s, ui: { ...s.ui, ...over } }));
    mount(store);
    return store;
  };

  it("focusing a provider swaps the chips for that provider's meters and a way back", () => {
    const store = focusedOn({ focusProvider: 'codex' });
    expect(chips()).toHaveLength(0);
    const focus = area().querySelector<HTMLElement>('.usage-focus')!;
    // AT doesn't read inside a button: the label carries the numbers and the reset times; the meters are decorative.
    expect(focus.getAttribute('aria-label')).toBe('Codex: 30% of 5-hour left, 18% of weekly left. 5-hour resets 2:40 pm, weekly resets Thu 9:00 am. Show details');
    const meters = [...focus.querySelectorAll<HTMLElement>('.m')];
    expect(meters.every((m) => m.getAttribute('aria-hidden') === 'true')).toBe(true);
    expect(meters.map((m) => m.querySelector('b')!.textContent)).toEqual(['30%', '18%']);
    expect(meters[1]!.getAttribute('data-level')).toBe('low');
    expect(meters[0]!.querySelector<HTMLElement>('i')!.style.getPropertyValue('--left')).toBe('0.3');
    // The meters open this provider's detail.
    fireEvent.click(focus);
    expect(pop().getAttribute('aria-label')).toBe('Codex usage');
    expect(pop().dataset.state).toBe('open');
    expect(focus.getAttribute('aria-expanded')).toBe('true');
    expect(pop().querySelectorAll('.prov-block')).toHaveLength(1);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(pop().dataset.state).toBe('closed');
    expect(focus.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(focus);
    fireEvent.click(screen.getByRole('button', { name: 'Usage for all providers' }));
    expect(store.getState().ui.focusProvider).toBeNull();
    expect(chips()).toHaveLength(2);
  });

  it('a focused provider that is not installed says "Not connected"', () => {
    focusedOn({ focusProvider: 'antigravity' });
    expect(area().querySelector('.usage-focus')!.getAttribute('aria-label')).toBe('Antigravity: Not connected. Show details');
  });

  it('a single-provider filter is a focus too; "Usage for all providers" clears that filter only', () => {
    const store = focusedOn({ filters: { ...initialState().ui.filters, provider: ['claude'], status: ['running'] } });
    expect(area().querySelector('.usage-focus')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Usage for all providers' }));
    expect(store.getState().ui.filters.provider).toBeNull();
    expect(store.getState().ui.filters.status).toEqual(['running']);
    expect(chips()).toHaveLength(2);
  });
});
