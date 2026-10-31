import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { openChatIn, type AppState } from '../../state/reducer.ts';
import { allChats, memoState, type RecentChat } from '../../state/selectors.ts';
import { useStore, useStoreInstance } from '../../state/store.ts';
import { openHistoryChat } from '../actions.ts';
import { relativeTime, dateTime } from '../board/format.ts';
import { FilterBar } from '../filters/FilterBar.tsx';
import { FilterButton } from '../filters/FilterMenu.tsx';
import { NO_FILTERS } from '../filters/model.ts';
import { Icon, ProviderLogo, providerName, StatusIcon } from '../primitives/index.ts';

/** Rows drawn at first; "Show more" adds this many again, so thousands of history chats never render at once. */
const PAGE = 100;

/** The search-icon focus request already handled (the counter lives in the store; a later visit must not refocus). */
let focusHandled = 0;

const select = memoState((s: AppState) => [s.chats, s.history, s.projects, s.settings, s.ui.chatsFilters, s.ui.archiving, s.now], (s) => allChats(s, s.now));

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

function Row({ c, q, now }: { c: RecentChat; q: string; now: number }) {
  const store = useStoreInstance();
  const open = () => {
    if (c.chatId) store.setState((s) => openChatIn(s, c.chatId!));
    else if (c.sessionRef) openHistoryChat({ provider: c.provider, sessionRef: c.sessionRef, cwd: c.cwd, title: c.title });
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
  const focusAsked = useStore((s) => s.ui.chatsSearchFocus);
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(PAGE);
  const box = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focusAsked > focusHandled) {
      focusHandled = focusAsked;
      box.current?.focus();
    }
  }, [focusAsked]);

  const q = query.trim().toLowerCase();
  const rows = useMemo(() => (q ? list.filter((c) => c.title.toLowerCase().includes(q) || c.projectName.toLowerCase().includes(q)) : list), [list, q]);
  const clear = () => { setQuery(''); store.setState((s) => ({ ...s, ui: { ...s.ui, chatsFilters: NO_FILTERS } })); };

  return (
    <div className="page all-chats-page">
      <div className="page-inner">
        <div className="ac-tools">
          <label className="search">
            <Icon name="search" size="sm" />
            <input ref={box} name="chat-search" type="search" autoComplete="off" spellCheck={false} placeholder="Search chats and projects" aria-label="Search chats"
              value={query} onChange={(e) => { setQuery(e.target.value); setShown(PAGE); }} />
          </label>
          <FilterButton scope="chats" />
          <span className="ac-count">{rows.length} {rows.length === 1 ? 'chat' : 'chats'}</span>
        </div>
        <FilterBar scope="chats" />
        {!loaded ? null : rows.length === 0 ? (
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
                <h3>No chats yet</h3>
                <p>Chats from Claude Code, Codex and Antigravity show up here.</p>
              </>
            )}
          </div>
        ) : (
          <>
            <ul className="chat-list chat-rows" aria-label="All chats">
              {rows.slice(0, shown).map((c) => <Row key={c.key} c={c} q={q} now={now} />)}
            </ul>
            {rows.length > shown && (
              <button className="show-more-row" type="button" onClick={() => setShown((n) => n + PAGE)}>Show {Math.min(PAGE, rows.length - shown)} more</button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
