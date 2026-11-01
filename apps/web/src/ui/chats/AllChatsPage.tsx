import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { openChatIn, type AppState } from '../../state/reducer.ts';
import { api } from '../../api/client.ts';
import { allChats, groupByDay, memoState, visibleProjects, type ListedChat } from '../../state/selectors.ts';
import { refreshHistory, useStore, useStoreInstance } from '../../state/store.ts';
import { openHistoryChat, openRowMenu } from '../actions.ts';
import { relativeTime, dateTime } from '../board/format.ts';
import { FilterBar } from '../filters/FilterBar.tsx';
import { FilterButton } from '../filters/FilterMenu.tsx';
import { NO_FILTERS } from '../filters/model.ts';
import { Icon, ProviderLogo, providerName, toast } from '../primitives/index.ts';
import { Dialog } from '../primitives/Dialog.tsx';
import { errorText } from '../board/Card.tsx';

/** Rows drawn at first; "Show more" adds this many again, so thousands of history chats never render at once. */
const PAGE = 100;

/** The search-icon focus request already handled (the counter lives in the store; a later visit must not refocus). */
let focusHandled = 0;

const select = memoState((s: AppState) => [s.chats, s.history, s.projects, s.settings, s.ui.chatsFilters, s.ui.chatsMode, s.ui.archiving, s.now], (s) => allChats(s, s.now));

/** `text` with the first case-insensitive match of `q` marked. */
function highlight(text: string, q: string): ReactNode {
  const i = q ? text.toLowerCase().indexOf(q) : -1;
  if (i < 0) return text;
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>;
}

function Row({ c, q, now, selected, onSelect }: { c: ListedChat; q: string; now: number; selected: boolean; onSelect: (shift: boolean) => void }) {
  const store = useStoreInstance();
  const open = () => {
    if (c.chatId) store.setState((s) => openChatIn(s, c.chatId!));
    else if (c.sessionRef) openHistoryChat({ provider: c.provider, sessionRef: c.sessionRef, cwd: c.cwd, title: c.title });
  };
  const more = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    openRowMenu({ chatId: c.chatId, history: c.sessionRef ? { provider: c.provider, sessionRef: c.sessionRef, cwd: c.cwd, title: c.title } : null }, e.currentTarget);
  };
  return (
    <li role="listitem">
      <div className="crow" role="button" tabIndex={0} title={`${c.title}\n${c.projectName} · ${providerName(c.provider)} · ${dateTime(c.updatedAt, now)}`}
        data-selected={selected || undefined} onClick={open} onKeyDown={(e) => {
          if (e.key === ' ') { e.preventDefault(); onSelect(e.shiftKey); }
          else if (e.key === 'Enter' && e.target === e.currentTarget) { e.preventDefault(); open(); }
        }}>
        <input className="chat-check" type="checkbox" checked={selected} aria-label={`Select ${c.title}`} onChange={() => {}}
          onClick={(e) => { e.stopPropagation(); onSelect(e.shiftKey); }} />
        <ProviderLogo id={c.provider} size="sm" alt={providerName(c.provider)} />
        <span className="t">{highlight(c.title, q)}</span>
        <span className="proj"><span className="folder-glyph proj-glyph" aria-hidden="true">{(c.projectName || '?')[0]!.toUpperCase()}</span><span>{highlight(c.projectName, q)}</span></span>
        <span className="chat-status">{c.column ? 'On board' : 'In history'}</span>
        <span className="when">{relativeTime(c.updatedAt, now)}</span>
        <button className="btn icon-only ghost row-more" type="button" aria-label="More actions" onClick={more}><Icon name="more" size="sm" /></button>
      </div>
    </li>
  );
}

/** `#/chats`: every chat, on the board or only in a provider's history, newest first; search and Project / Provider filters. */
export function AllChatsPage() {
  const store = useStoreInstance();
  const list = useStore(select);
  const now = useStore((s) => s.now);
  const loaded = useStore((s) => s.loaded);
  const filtering = useStore((s) => Object.values(s.ui.chatsFilters).some((v) => v !== null));
  const mode = useStore((s) => s.ui.chatsMode);
  const trash = useStore((s) => s.trash);
  const projects = useStore((s) => visibleProjects(s));
  const focusAsked = useStore((s) => s.ui.chatsSearchFocus);
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [emptying, setEmptying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkDelete, setBulkDelete] = useState(false);
  const [moving, setMoving] = useState(false);
  const box = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focusAsked > focusHandled) {
      focusHandled = focusAsked;
      // Global search's "See all results" hands over its query.
      setQuery(store.getState().ui.chatsSearchText);
      setShown(PAGE);
      box.current?.focus();
    }
  }, [focusAsked]);

  const q = query.trim().toLowerCase();
  const rows = useMemo(() => (q ? list.filter((c) => c.title.toLowerCase().includes(q) || c.projectName.toLowerCase().includes(q)) : list), [list, q]);
  const trashRows = useMemo(() => (q ? trash.filter((e) => e.title.toLowerCase().includes(q) || providerName(e.provider).toLowerCase().includes(q)) : trash), [trash, q]);
  const clear = () => { setQuery(''); store.setState((s) => ({ ...s, ui: { ...s.ui, chatsFilters: NO_FILTERS } })); };
  const setMode = (next: 'active' | 'archived' | 'trash') => {
    setShown(PAGE);
    store.setState((s) => ({ ...s, ui: { ...s.ui, chatsMode: next } }));
  };
  const restore = async (id: string) => {
    const pending = store.getState().trash.find((e) => e.id === id);
    store.setState((s) => ({ ...s, trash: s.trash.filter((e) => e.id !== id) }));
    try {
      const entry = await api.restoreTrash(id);
      store.setState((s) => ({
        ...s,
        chats: entry.chatId && s.chats[entry.chatId] ? { ...s.chats, [entry.chatId]: { ...s.chats[entry.chatId]!, deletedAt: null } } : s.chats,
      }));
      if (!entry.chatId) await refreshHistory(store, api);
      toast('Chat restored');
    } catch (err) {
      if (pending) store.setState((s) => ({ ...s, trash: [pending, ...s.trash.filter((e) => e.id !== pending.id)] }));
      toast(errorText(err));
    }
  };
  const emptyTrash = async () => {
    setBusy(true);
    try { await api.emptyTrash(); store.setState((s) => ({ ...s, trash: [] })); setEmptying(false); toast('Trash emptied'); }
    catch (err) { toast(errorText(err)); }
    finally { setBusy(false); }
  };
  const count = mode === 'trash' ? trashRows.length : rows.length;
  const visibleRows = useMemo(() => rows.slice(0, shown), [rows, shown]);
  const groups = useMemo(() => groupByDay(visibleRows, now), [visibleRows, now]);
  const rowIndex = useMemo(() => new Map(visibleRows.map((row, i) => [row.key, i])), [visibleRows]);
  const clearSelection = () => { setSelected(new Set()); setAnchor(null); };
  const toggle = (key: string, shift: boolean) => {
    const index = rowIndex.get(key);
    if (index === undefined) return;
    setSelected((current) => {
      const next = new Set(current);
      if (shift && anchor !== null) {
        const [from, to] = anchor < index ? [anchor, index] : [index, anchor];
        for (let i = from; i <= to; i++) next.add(visibleRows[i]!.key);
      } else if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
    setAnchor(index);
  };

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape' && selected.size > 0) clearSelection(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selected.size]);
  useEffect(clearSelection, [mode]);

  const applyBulk = async (action: 'archive' | 'unarchive' | 'delete' | 'move', projectLabel?: string) => {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      const result = await api.bulkChats(ids, action, projectLabel);
      const done = new Set(result.done);
      store.setState((s) => ({
        ...s,
        chats: Object.fromEntries(Object.entries(s.chats).map(([id, chat]) => [id, !done.has(id) ? chat
          : action === 'archive' ? { ...chat, archived: true }
            : action === 'unarchive' ? { ...chat, archived: false }
              : action === 'delete' ? { ...chat, deletedAt: new Date().toISOString() }
                : { ...chat, projectLabel: projectLabel ?? null }])),
        history: s.history
          .filter((h) => !(action === 'delete' && done.has(`h:${h.provider}:${h.sessionRef}`)))
          .map((h) => done.has(`h:${h.provider}:${h.sessionRef}`) && (action === 'archive' || action === 'unarchive') ? { ...h, archived: action === 'archive' } : h),
      }));
      if (action === 'delete') api.trash().then((next) => store.setState((s) => ({ ...s, trash: next }))).catch(() => {});
      const verb = action === 'archive' ? 'archived' : action === 'unarchive' ? 'unarchived' : action === 'delete' ? 'moved to Trash' : 'moved';
      toast(`${result.done.length} ${verb}${result.skipped.length ? ` · ${result.skipped.length} skipped` : ''}`,
        action === 'archive' && result.done.length ? { label: 'Undo', run: () => void api.bulkChats(result.done, 'unarchive').then(() => {
          store.setState((s) => ({ ...s,
            chats: Object.fromEntries(Object.entries(s.chats).map(([id, chat]) => [id, done.has(id) ? { ...chat, archived: false } : chat])),
            history: s.history.map((h) => done.has(`h:${h.provider}:${h.sessionRef}`) ? { ...h, archived: false } : h),
          }));
        }).catch((err: unknown) => toast(errorText(err))) } : undefined);
      clearSelection(); setBulkDelete(false); setMoving(false);
    } catch (err) { toast(errorText(err)); }
    finally { setBulkBusy(false); }
  };

  return (
    <div className="page all-chats-page">
      <div className="page-inner">
        <div className="page-head">
          <div className="t">
            <h2 className="page-title">All chats <span className="count">{count}</span></h2>
            <p>Every chat from Claude Code, Codex and Antigravity, on the board or only in their own history. Newest first.</p>
          </div>
          <label className="search">
            <Icon name="search" size="sm" />
            <input ref={box} name="chat-search" type="search" autoComplete="off" spellCheck={false} placeholder="Search chats and projects" aria-label="Search chats"
              value={query} onChange={(e) => { setQuery(e.target.value); setShown(PAGE); }} />
          </label>
          <FilterButton scope="chats" />
        </div>
        <div className="chat-lifecycle" role="tablist" aria-label="Chat lifecycle">
          <button className="btn" type="button" role="tab" aria-selected={mode === 'active'} onClick={() => setMode('active')}>Active</button>
          <button className="btn" type="button" role="tab" aria-selected={mode === 'archived'} onClick={() => setMode('archived')}>Archived</button>
          <button className="btn" type="button" role="tab" aria-selected={mode === 'trash'} onClick={() => setMode('trash')}>Trash</button>
          {mode !== 'trash' && visibleRows.length > 0 && <button className="btn ghost select-view" type="button" onClick={() => setSelected(new Set(visibleRows.map((c) => c.key)))}>Select all in view</button>}
          {mode === 'trash' && trash.length > 0 && <button className="btn ghost trash-empty" type="button" onClick={() => setEmptying(true)}>Empty trash</button>}
        </div>
        <FilterBar scope="chats" />
        {!loaded ? null : count === 0 ? (
          <div className="page-empty">
            <Icon name="search" />
            {q || filtering ? (
              <>
                <h3>No chats match</h3>
                <p>Try a shorter search, or clear the filters.</p>
                <button className="btn" type="button" onClick={clear}>Clear search and filters</button>
              </>
            ) : (
              <>
                <h3>{mode === 'archived' ? 'No archived chats' : mode === 'trash' ? 'Trash is empty' : 'No chats yet'}</h3>
                <p>{mode === 'archived' ? 'Chats you archive show up here.' : mode === 'trash' ? 'Deleted chats stay here for 30 days.' : 'Chats from Claude Code, Codex and Antigravity show up here.'}</p>
              </>
            )}
          </div>
        ) : (
          <>
            {mode === 'trash' ? <ul className="chat-list chat-rows" aria-label="Trash">
              {trashRows.slice(0, shown).map((entry) => (
                <li key={entry.id}><div className="crow trash-row">
                  <span className="nostate" aria-hidden="true" />
                  <ProviderLogo id={entry.provider} size="sm" alt={providerName(entry.provider)} />
                  <span className="t">{highlight(entry.title, q)}</span>
                  <span className="trash-days">{entry.daysLeft} {entry.daysLeft === 1 ? 'day' : 'days'} left</span>
                  <button className="btn" type="button" onClick={() => void restore(entry.id)}>Restore</button>
                </div></li>
              ))}
            </ul> : <div className="chat-groups" role="list" aria-label="All chats">
              {groups.map((group) => {
                const id = `chat-group-${group.label.toLowerCase().replace(' ', '-')}`;
                return <section className="chat-day" key={group.label} aria-labelledby={id}>
                  <h3 id={id}>{group.label}</h3>
                  <ul className="chat-list chat-rows" role="presentation">
                    {group.chats.map((c) => <Row key={c.key} c={c} q={q} now={now} selected={selected.has(c.key)} onSelect={(shift) => toggle(c.key, shift)} />)}
                  </ul>
                </section>;
              })}
            </div>}
            {count > shown && (
              <button className="show-more-row" type="button" onClick={() => setShown((n) => n + PAGE)}>Show {Math.min(PAGE, count - shown)} more</button>
            )}
          </>
        )}
      </div>
      <Dialog open={emptying} onClose={() => { if (!busy) setEmptying(false); }} title="Empty trash?"
        footer={<><span className="grow" /><button className="btn ghost" type="button" disabled={busy} onClick={() => setEmptying(false)}>Cancel</button>
          <button className="btn danger" type="button" disabled={busy} onClick={() => void emptyTrash()}>Empty trash</button></>}>
        <p>These chats will be gone for good.</p>
      </Dialog>
      {selected.size > 0 && <div className="bulk-bar" role="region" aria-label="Selected chat actions">
        <span className="bulk-count" role="status" aria-live="polite">{selected.size} selected</span>
        <button className="btn" type="button" disabled={bulkBusy} onClick={() => void applyBulk(mode === 'archived' ? 'unarchive' : 'archive')}>{mode === 'archived' ? 'Unarchive' : 'Archive'}</button>
        <button className="btn" type="button" disabled={bulkBusy} onClick={() => setMoving(true)}>Move to project</button>
        <button className="btn danger" type="button" disabled={bulkBusy} onClick={() => setBulkDelete(true)}>Delete</button>
        <button className="btn ghost" type="button" disabled={bulkBusy} onClick={clearSelection}>Clear</button>
      </div>}
      <Dialog open={bulkDelete} onClose={() => { if (!bulkBusy) setBulkDelete(false); }} title={`Delete ${selected.size} chats?`}
        footer={<><span className="grow" /><button className="btn ghost" type="button" disabled={bulkBusy} onClick={() => setBulkDelete(false)}>Cancel</button>
          <button className="btn danger" type="button" disabled={bulkBusy} onClick={() => void applyBulk('delete')}>Delete chats</button></>}>
        <p>They go to Trash for 30 days. Running and Antigravity chats will be skipped.</p>
      </Dialog>
      <Dialog open={moving} onClose={() => { if (!bulkBusy) setMoving(false); }} title="Move chats to project">
        <div className="bulk-projects">{projects.map((project) => <button className="btn" type="button" disabled={bulkBusy} key={project.id} onClick={() => void applyBulk('move', project.path)}>{project.name}</button>)}</div>
      </Dialog>
    </div>
  );
}
