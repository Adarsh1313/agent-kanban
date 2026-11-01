import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Project, Routine } from '@agent-kanban/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client.ts';
import { applyEvent, applySnapshot, initialState } from '../src/state/reducer.ts';
import { createStore, StoreProvider, type Store } from '../src/state/store.ts';
import { Toasts } from '../src/ui/primitives/toast.tsx';
import { RoutineEditor, RoutinesPage } from '../src/ui/routines/RoutinesPage.tsx';
import { nextRunText, scheduleText } from '../src/ui/routines/model.ts';

vi.mock('../src/api/client.ts', async (orig) => {
  const m = await orig<typeof import('../src/api/client.ts')>();
  return { ...m, api: { ...m.api, createRoutine: vi.fn(), patchRoutine: vi.fn(), deleteRoutine: vi.fn(), runRoutine: vi.fn() } };
});
const mocked = api as unknown as Record<'createRoutine' | 'patchRoutine' | 'deleteRoutine' | 'runRoutine', ReturnType<typeof vi.fn>>;

// Local times: Friday 30 Oct 2026, 7:00 am.
const NOW = new Date(2026, 9, 30, 7, 0).getTime();
const project = (path: string): Project => ({
  id: path, name: path.split('/').pop()!, path, providers: [], columns: { running: 0, needs_you: 0, review: 0, done: 0 },
  historyOnly: 0, lastActivityAt: '2026-10-29T00:00:00.000Z', hidden: null, folderMissing: false,
});
const routine = (over: Partial<Routine> = {}): Routine => ({
  id: 'r1', name: 'Morning review', cwd: '/work/alpha', provider: 'codex', effort: 'normal', kind: 'prompt', text: 'Review yesterday',
  schedule: { days: [1, 2, 3, 4, 5], time: '08:00' }, paused: false, chime: false, lastRunAt: null, lastResult: null, lastChatId: null,
  nextRunAt: new Date(2026, 9, 30, 8, 0).toISOString(), createdAt: '2026-10-29T00:00:00.000Z', ...over,
});

function seeded(routines: Routine[]): Store {
  const s = applySnapshot(initialState(), { chats: [], usage: [], suggested: 'codex', connections: [], history: [], projects: [project('/work/alpha'), project('/work/beta')], routines });
  return createStore({ ...s, now: NOW, ui: { ...s.ui, view: 'routines' } });
}
const mount = (store: Store) => render(<StoreProvider store={store}><RoutinesPage /><RoutineEditor /><Toasts /></StoreProvider>);

beforeEach(() => { for (const k of ['createRoutine', 'patchRoutine', 'deleteRoutine', 'runRoutine'] as const) { mocked[k].mockReset(); mocked[k].mockResolvedValue(undefined); } });
afterEach(() => cleanup());

describe('schedule in words', () => {
  it('says Daily, Weekdays or the chosen days, and when the next run is', () => {
    expect(scheduleText({ days: [0, 1, 2, 3, 4, 5, 6], time: '18:30' })).toBe('Daily at 6:30 pm');
    expect(scheduleText({ days: [1, 2, 3, 4, 5], time: '08:00' })).toBe('Weekdays at 8:00 am');
    expect(scheduleText({ days: [0, 1, 3], time: '00:05' })).toBe('Mon, Wed, Sun at 12:05 am');
    expect(nextRunText(new Date(2026, 9, 31, 9, 0).toISOString(), NOW)).toBe('Tomorrow 9:00 am');
    expect(nextRunText(new Date(2026, 10, 2, 8, 0).toISOString(), NOW)).toBe('Mon 8:00 am');
    expect(nextRunText(null, NOW)).toBe('Paused');
  });
});

describe('Routines page', () => {
  it('lists each routine with its schedule in words, next run and last result', () => {
    mount(seeded([routine(), routine({ id: 'r2', name: 'Tidy', paused: true, nextRunAt: null, lastResult: 'ran_late' })]));
    expect(screen.getByRole('heading', { name: /Routines/ }).textContent).toContain('2');
    const rows = within(screen.getByRole('list', { name: 'Routines' })).getAllByRole('listitem');
    expect(rows[0]!.textContent).toContain('Weekdays at 8:00 am');
    expect(rows[0]!.textContent).toContain('Today 8:00 am');
    expect(rows[0]!.textContent).toContain('Not run yet');
    expect(rows[1]!.textContent).toContain('Paused');
    expect(rows[1]!.textContent).toContain('Ran late');
    expect(screen.getByRole('heading', { name: /Routines/ }).parentElement!.textContent).toContain('only while Agent Kanban is open');
  });

  it('follows routines.updated', () => {
    const store = seeded([]);
    mount(store);
    expect(screen.getByText('No routines yet')).toBeTruthy();
    act(() => store.setState((s) => applyEvent(s, { type: 'routines.updated', routines: [routine()] })));
    expect(screen.getByText('Morning review')).toBeTruthy();
  });

  it('the editor creates a routine on chosen days', async () => {
    mocked.createRoutine.mockResolvedValue(routine());
    mount(seeded([]));
    fireEvent.click(screen.getAllByRole('button', { name: /New routine/ })[0]!);
    const dlg = await screen.findByRole('dialog', { name: 'New routine' });
    fireEvent.change(within(dlg).getByLabelText('Name'), { target: { value: 'Weekly tidy' } });
    fireEvent.change(within(dlg).getByLabelText('Project'), { target: { value: '/work/beta' } });
    fireEvent.change(within(dlg).getByLabelText('Skill or prompt'), { target: { value: 'Tidy the repo' } });
    fireEvent.click(within(dlg).getByRole('radio', { name: 'Chosen days' }));
    const days = within(dlg).getByRole('group', { name: 'Days' });
    for (const d of ['Tuesday', 'Wednesday', 'Thursday', 'Friday']) fireEvent.click(within(days).getByRole('button', { name: d }));
    expect(within(days).getByRole('button', { name: 'Monday' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(days).getByRole('button', { name: 'Saturday' }));
    fireEvent.change(within(dlg).getByLabelText('Time'), { target: { value: '17:30' } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Create routine' }));
    await waitFor(() => expect(mocked.createRoutine).toHaveBeenCalledTimes(1));
    expect(mocked.createRoutine.mock.calls[0]![0]).toEqual({
      name: 'Weekly tidy', cwd: '/work/beta', provider: 'codex', effort: 'normal', kind: 'prompt', text: 'Tidy the repo',
      schedule: { days: [1, 6], time: '17:30' }, chime: false,
    });
  });

  it('the editor says what is missing instead of sending', async () => {
    mount(seeded([]));
    fireEvent.click(screen.getAllByRole('button', { name: /New routine/ })[0]!);
    const dlg = await screen.findByRole('dialog', { name: 'New routine' });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Create routine' }));
    expect(within(dlg).getByRole('alert').textContent).toBe('Give the routine a name.');
    expect(mocked.createRoutine).not.toHaveBeenCalled();
  });

  it('Pause, Run now and Delete (after confirming)', async () => {
    mount(seeded([routine()]));
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(mocked.patchRoutine).toHaveBeenCalledWith('r1', { paused: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Run Morning review now' }));
    await waitFor(() => expect(mocked.runRoutine).toHaveBeenCalledWith('r1'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Morning review' }));
    const dlg = await screen.findByRole('dialog', { name: 'Delete this routine?' });
    expect(dlg.textContent).toContain('chats it already made stay');
    expect(mocked.deleteRoutine).not.toHaveBeenCalled();
    fireEvent.click(within(dlg).getByRole('button', { name: 'Delete routine' }));
    await waitFor(() => expect(mocked.deleteRoutine).toHaveBeenCalledWith('r1'));
  });
});
