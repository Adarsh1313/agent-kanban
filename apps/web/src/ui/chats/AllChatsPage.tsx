import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { openChatIn, type AppState } from '../../state/reducer.ts';
import { api } from '../../api/client.ts';
import { allChats, memoState, type ListedChat } from '../../state/selectors.ts';
import { refreshHistory, useStore, useStoreInstance } from '../../state/store.ts';
import { openHistoryChat, openRowMenu } from '../actions.ts';
import { relativeTime, dateTime } from '../board/format.ts';
import { FilterBar } from '../filters/FilterBar.tsx';
import { FilterButton } from '../filters/FilterMenu.tsx';
import { NO_FILTERS } from '../filters/model.ts';
import { Icon, ProviderLogo, providerName, StatusIcon, toast } from '../primitives/index.ts';
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

function onActivate(fn: () => void) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
      e.preventDefault();
      fn();
    }
  };
}

function Row({ c, q, now }: { c: ListedChat; q: string; now: number }) {
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
    <li>
      <div className="crow" role="button" tabIndex={0} title={`${c.title}\n${c.projectName} · ${providerName(c.provider)} · ${dateTime(c.updatedAt, now)}`}
        onClick={open} onKeyDown={onActivate(open)}>
        {c.column ? <StatusIcon state={c.column} /> : <span className="nostate" title={`In ${providerName(c.provider)} history`} />}
        <ProviderLogo id={c.provider} size="sm" alt={providerName(c.provider)} />
        <span className="t">{highlight(c.title, q)}</span>
        <span className="proj"><span className="folder-glyph proj-glyph" aria-hidden="true">{(c.projectName || '?')[0]!.toUpperCase()}</span><span>{highlight(c.projectName, q)}</span></span>
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
  const focusAsked = useStore((s) => s.ui.chatsSearchFocus);
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [emptying, setEmptying] = useState(false);
  const [busy, setBusy] = useState(false);
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
            <ul className="chat-list chat-rows" aria-label={mode === 'trash' ? 'Trash' : 'All chats'}>
              {mode === 'trash' ? trashRows.slice(0, shown).map((entry) => (
                <li key={entry.id}><div className="crow trash-row">
                  <span className="nostate" aria-hidden="true" />
                  <ProviderLogo id={entry.provider} size="sm" alt={providerName(entry.provider)} />
                  <span className="t">{highlight(entry.title, q)}</span>
                  <span className="trash-days">{entry.daysLeft} {entry.daysLeft === 1 ? 'day' : 'days'} left</span>
                  <button className="btn" type="button" onClick={() => void restore(entry.id)}>Restore</button>
                </div></li>
              )) : rows.slice(0, shown).map((c) => <Row key={c.key} c={c} q={q} now={now} />)}
            </ul>
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
    </div>
  );
}
