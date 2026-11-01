import type { Settings } from '@agent-kanban/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client.ts';
import { handleServerEvent } from '../src/App.tsx';
import { applySnapshot, initialState } from '../src/state/reducer.ts';
import { createStore } from '../src/state/store.ts';

vi.mock('../src/api/client.ts', async (orig) => {
  const m = await orig<typeof import('../src/api/client.ts')>();
  return { ...m, api: { ...m.api, history: vi.fn(), projects: vi.fn() } };
});
type Fn = ReturnType<typeof vi.fn>;
const mocked = api as unknown as { history: Fn; projects: Fn };

const ON = { claude: true, codex: true, antigravity: true };
const SETTINGS: Settings = { onboarded: true, showChats: ON, suggest: ON, hiddenProjects: [], unhiddenProjects: [], suggestNextSteps: true };
const seeded = () => createStore(applySnapshot(initialState(), { chats: [], usage: [], suggested: null, connections: [], history: [], projects: [], settings: SETTINGS }));
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  mocked.history.mockReset().mockResolvedValue([{ provider: 'claude', sessionRef: 'h1', title: 't', cwd: '/w', updatedAt: '2026-10-23T12:00:00.000Z' }]);
  mocked.projects.mockReset().mockResolvedValue([]);
});

describe('live settings.updated', () => {
  it('a showChats change from another tab refetches history and projects', async () => {
    const store = seeded();
    handleServerEvent(store, { type: 'settings.updated', settings: { ...SETTINGS, showChats: { ...ON, codex: false } } });
    expect(store.getState().settings?.showChats.codex).toBe(false);
    expect(mocked.history).toHaveBeenCalledTimes(1);
    expect(mocked.projects).toHaveBeenCalledTimes(1);
    await flush();
    expect(store.getState().history).toHaveLength(1);
  });

  it('a change that leaves showChats alone (suggest, onboarded, or our own echo) refetches nothing', () => {
    const store = seeded();
    handleServerEvent(store, { type: 'settings.updated', settings: { ...SETTINGS, suggest: { ...ON, claude: false } } });
    handleServerEvent(store, { type: 'settings.updated', settings: { ...SETTINGS, suggest: { ...ON, claude: false } } });
    expect(store.getState().settings?.suggest.claude).toBe(false);
    expect(mocked.history).not.toHaveBeenCalled();
    expect(mocked.projects).not.toHaveBeenCalled();
  });
});
