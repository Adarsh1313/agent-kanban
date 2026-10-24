import { describe, expect, it } from 'vitest';
import { applySnapshot, initialState, type AppState, type Filters } from '../src/state/reducer.ts';
import { boardColumns, focusedProvider, pinned, projectLabel, providerCounts, recentChatsByProject, suggestFor, unreadCount, visibleChats } from '../src/state/selectors.ts';
import { filterOptions } from '../src/ui/filters/model.ts';
import { chat } from './helpers.ts';

const NOW = Date.parse('2026-10-23T12:00:00.000Z');
const noFilters: Filters = { provider: null, project: null, status: null, model: null, reason: null, activity: null, source: null };

function state(chats = [chat()], extra: Partial<AppState> = {}, history: AppState['history'] = []): AppState {
  const s = applySnapshot(initialState(), { chats, usage: [], suggested: null, connections: [], history, projects: [] });
  return { ...s, ...extra };
}
const withFilters = (s: AppState, f: Partial<Filters>): AppState =>
  ({ ...s, ui: { ...s.ui, filters: { ...noFilters, ...f } } });
const ids = (s: AppState) => visibleChats(s, NOW).map((c) => c.id).sort();

describe('filters', () => {
  const s = state([
    chat({ id: 'a', provider: 'claude', cwd: '/p/one', model: 'sonnet', column: 'running', updatedAt: '2026-10-23T11:30:00.000Z' }),
    chat({ id: 'b', provider: 'codex', cwd: '/p/two', model: 'gpt', column: 'needs_you', needsReason: 'permission', updatedAt: '2026-10-23T05:00:00.000Z' }),
    chat({ id: 'c', provider: 'claude', cwd: '/p/one', model: 'opus', column: 'needs_you', needsReason: 'limit', updatedAt: '2026-10-20T05:00:00.000Z' }),
    chat({ id: 'd', provider: 'antigravity', cwd: '/p/two', model: null, column: 'done', updatedAt: '2026-09-01T05:00:00.000Z' }),
    chat({ id: 'h', column: null }),
  ]);

  it('no filters shows every board chat and nothing history-only', () => {
    expect(ids(s)).toEqual(['a', 'b', 'c', 'd']);
  });
  it('provider, project, status, model, reason', () => {
    expect(ids(withFilters(s, { provider: ['codex', 'antigravity'] }))).toEqual(['b', 'd']);
    expect(ids(withFilters(s, { project: ['/p/one'] }))).toEqual(['a', 'c']);
    expect(ids(withFilters(s, { status: ['needs_you', 'done'] }))).toEqual(['b', 'c', 'd']);
    expect(ids(withFilters(s, { model: ['opus', 'gpt'] }))).toEqual(['b', 'c']);
    expect(ids(withFilters(s, { reason: ['limit'] }))).toEqual(['c']);
  });
  it('filters combine with AND', () => {
    expect(ids(withFilters(s, { provider: ['claude'], status: ['needs_you'] }))).toEqual(['c']);
  });
  it('activity: hour, today, week', () => {
    expect(ids(withFilters(s, { activity: 'hour' }))).toEqual(['a']);
    expect(ids(withFilters(s, { activity: 'today' }))).toEqual(['a', 'b']);
    expect(ids(withFilters(s, { activity: 'week' }))).toEqual(['a', 'b', 'c']);
  });
  it('started in: board chats are "here"; "native" matches no board chat', () => {
    expect(ids(withFilters(s, { source: ['here'] }))).toEqual(['a', 'b', 'c', 'd']);
    expect(ids(withFilters(s, { source: ['native'] }))).toEqual([]);
  });
  it('a single provider filter focuses that provider', () => {
    expect(focusedProvider(withFilters(s, { provider: ['codex'] }))).toBe('codex');
    expect(focusedProvider(withFilters(s, { provider: ['codex', 'claude'] }))).toBeNull();
    expect(ids(withFilters(s, { provider: ['claude'] }))).toEqual(['a', 'c']);
  });
  it('archived chats are hidden', () => {
    expect(ids(state([chat({ id: 'x', archived: true })]))).toEqual([]);
  });
});

describe('snooze', () => {
  it('hides snoozed chats from board, pinned and sidebar until the time passes', () => {
    const s = state([chat({ id: 'z', pinned: true, snoozedUntil: '2026-10-23T13:00:00.000Z' })]);
    expect(ids(s)).toEqual([]);
    expect(pinned(s, NOW)).toEqual([]);
    expect(recentChatsByProject(s, NOW)).toEqual([]);
    const later = Date.parse('2026-10-23T13:00:01.000Z');
    expect(visibleChats(s, later)).toHaveLength(1);
    expect(pinned(s, later)).toHaveLength(1);
  });
});

describe('boardColumns', () => {
  it('groups by column, newest first', () => {
    const s = state([
      chat({ id: 'a', column: 'running', updatedAt: '2026-10-23T10:00:00.000Z' }),
      chat({ id: 'b', column: 'running', updatedAt: '2026-10-23T11:00:00.000Z' }),
      chat({ id: 'c', column: 'review' }),
    ]);
    const cols = boardColumns(s, NOW);
    expect(cols.running.map((c) => c.id)).toEqual(['b', 'a']);
    expect(cols.review).toHaveLength(1);
    expect(cols.needs_you).toEqual([]);
    expect(cols.done).toEqual([]);
  });
});

describe('recentChatsByProject', () => {
  it('shows 4 projects x 3 chats, most recent project first, pinned excluded', () => {
    const list = [];
    for (let p = 0; p < 6; p++) for (let i = 0; i < 5; i++) {
      list.push(chat({ id: `p${p}c${i}`, cwd: `/w/proj${p}`, updatedAt: new Date(NOW - (p * 10 + i) * 60000).toISOString(), pinned: p === 0 && i === 0 }));
    }
    const groups = recentChatsByProject(state(list), NOW);
    expect(groups).toHaveLength(4);
    expect(groups.map((g) => g.name)).toEqual(['proj0', 'proj1', 'proj2', 'proj3']);
    expect(groups[0]!.chats.map((c) => c.chatId)).toEqual(['p0c1', 'p0c2', 'p0c3']);
    expect(groups[0]!.total).toBe(4);
  });
  it('includes history-only chats without a matching board chat, and honors provider focus', () => {
    const s = state(
      [chat({ id: 'a', sessionRef: 'S1', cwd: '/w/x' })],
      {},
      [
        { provider: 'claude', sessionRef: 'S1', title: 'dup', cwd: '/w/x', updatedAt: '2026-10-23T09:00:00.000Z' },
        { provider: 'codex', sessionRef: 'S2', title: 'native one', cwd: '/w/x', updatedAt: '2026-10-23T08:00:00.000Z' },
      ],
    );
    const all = recentChatsByProject(s, NOW)[0]!.chats;
    expect(all.map((c) => c.title)).toEqual(['A chat', 'native one']);
    expect(all[1]).toMatchObject({ chatId: null, sessionRef: 'S2', provider: 'codex' });
    expect(recentChatsByProject(withFilters(s, { provider: ['claude'] }), NOW)[0]!.chats).toHaveLength(1);
  });
});

describe('pinned, unreadCount, suggestFor', () => {
  it('pinned lists pinned non-archived chats', () => {
    const s = state([chat({ id: 'a', pinned: true }), chat({ id: 'b' }), chat({ id: 'c', pinned: true, archived: true })]);
    expect(pinned(s, NOW).map((c) => c.id)).toEqual(['a']);
  });
  it('unreadCount counts unread notifications', () => {
    const s = state([], { notifications: [{ id: '1', chatId: 'a', kind: 'finished', at: 'x', unread: true }, { id: '2', chatId: 'a', kind: 'error', at: 'x', unread: false }] });
    expect(unreadCount(s)).toBe(1);
  });
  it('suggestFor uses the server suggestion, else the first allowed provider with suggested:false', () => {
    expect(suggestFor(state([], { suggested: 'codex' }), ['claude', 'codex'])).toEqual({ provider: 'codex', suggested: true });
    expect(suggestFor(state([], { suggested: null }), ['antigravity', 'claude'])).toEqual({ provider: 'antigravity', suggested: false });
    expect(suggestFor(state([], { suggested: 'codex' }), ['claude'])).toEqual({ provider: 'claude', suggested: false });
    expect(suggestFor(state(), [])).toBeNull();
  });
});

describe('sidebar helpers', () => {
  it('providerCounts adds history chats the board does not already hold', () => {
    const s = state([chat({ id: 'a', sessionRef: 'known' }), chat({ id: 'b', provider: 'codex', sessionRef: 'x', archived: true })], {}, [
      { provider: 'claude', sessionRef: 'known', title: 'dup', cwd: '/x', updatedAt: '2026-10-01T00:00:00.000Z' },
      { provider: 'claude', sessionRef: 'new', title: 'new', cwd: '/x', updatedAt: '2026-10-01T00:00:00.000Z' },
    ]);
    expect(providerCounts(s)).toEqual({ claude: 2, codex: 0, antigravity: 0 });
  });
  it('recentChatsByProject lists every chat of an expanded project', () => {
    const s = state(Array.from({ length: 5 }, (_, i) => chat({ id: `c${i}`, sessionRef: `r${i}`, updatedAt: `2026-10-23T10:0${i}:00.000Z` })));
    expect(recentChatsByProject(s, NOW)[0]!.chats).toHaveLength(3);
    expect(recentChatsByProject(s, NOW, undefined, new Set(['/work/alpha']))[0]!.chats).toHaveLength(5);
  });
  it('projectLabel falls back to the folder name', () => {
    expect(projectLabel(state(), String.raw`C:\Users\me\open-project`)).toBe('open-project');
  });
  it('providerCounts leaves out a chat being archived (Undo toast showing)', () => {
    const s = state([chat({ id: 'a', sessionRef: 'r1' }), chat({ id: 'b', sessionRef: 'r2' })]);
    expect(providerCounts(s).claude).toBe(2);
    const archiving = { ...s, ui: { ...s.ui, archiving: { b: true as const } } };
    expect(providerCounts(archiving).claude).toBe(1);
  });
});

describe('one folder, however it is spelled', () => {
  const spellings = [String.raw`C:\a`, String.raw`c:\a\ `.trim(), 'C:/a'];
  const s = state(spellings.map((cwd, i) => chat({ id: `c${i}`, sessionRef: `r${i}`, cwd, updatedAt: `2026-10-23T10:0${i}:00.000Z` })));
  it('the sidebar shows one group', () => {
    const groups = recentChatsByProject(s, NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.total).toBe(3);
  });
  it('filtering by any spelling matches every spelling', () => {
    for (const p of spellings) expect(ids(withFilters(s, { project: [p] }))).toEqual(['c0', 'c1', 'c2']);
  });
  it('the Project filter offers one option', () => {
    expect(filterOptions(s, 'project')).toHaveLength(1);
  });
});
