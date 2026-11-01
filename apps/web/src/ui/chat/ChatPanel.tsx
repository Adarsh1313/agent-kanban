import type { Chat, Column } from '@agent-kanban/shared';
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { api } from '../../api/client.ts';
import { closePanelIn, isChatLoaded, mergeChats, openChatIn, openHistoryIn, type HistoryRef } from '../../state/reducer.ts';
import { isArchived, projectLabel } from '../../state/selectors.ts';
import { loadChat, noteChatFolder, refreshHistory, useStore, useStoreInstance } from '../../state/store.ts';
import { setHistoryHandler, setRowMenuHandler } from '../actions.ts';
import { errorText, RESUME_TEXT } from '../board/Card.tsx';
import { relativeTime } from '../board/format.ts';
import { Icon, ProviderLogo, StatusIcon, Switch, Tooltip, providerName, toast } from '../primitives/index.ts';
import { pushLayer } from '../primitives/layers.ts';
import { ChatActionsMenu, runAction, type ChatActionsTarget } from './ChatActionsMenu.tsx';
import { Composer } from './Composer.tsx';
import { Thread } from './Thread.tsx';
import { addAfterStart } from '../myprojects/model.ts';
import { HistoryThread } from './HistoryThread.tsx';

const STATE_TEXT: Record<Column, string> = { running: 'Running', needs_you: 'Needs you', review: 'Ready for review', done: 'Done' };
const HINT = 'Enter to send · Shift+Enter for a new line';

type Shown = { kind: 'chat'; chat: Chat } | { kind: 'history'; ref: HistoryRef; updatedAt: string | null };

function lastActive(iso: string | null, now: number): string {
  if (!iso) return 'From your history';
  const rel = relativeTime(iso, now);
  if (rel === 'now') return 'Active just now';
  if (rel === 'Yesterday') return 'Last active yesterday';
  return `Last active ${rel} ago`;
}

function TitleEdit({ chat, onDone }: { chat: Chat; onDone: () => void }) {
  const store = useStoreInstance();
  const done = useRef(false);
  const save = (value: string) => {
    if (done.current) return;
    done.current = true;
    onDone();
    const title = value.trim();
    if (title && title !== chat.title) void runAction(store, () => api.patchChat(chat.id, { title }));
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      save(e.currentTarget.value);
    } else if (e.key === 'Escape') {
      // Cancels the edit only; the panel stays open.
      e.preventDefault();
      e.stopPropagation();
      done.current = true;
      onDone();
    }
  };
  return (
    <input id="panel-title" className="title-edit" aria-label="Chat title" defaultValue={chat.title} autoFocus maxLength={200}
      onFocus={(e) => e.currentTarget.select()} onKeyDown={onKey} onBlur={(e) => save(e.currentTarget.value)} />
  );
}

/** Out of usage (#39): what waits for the reset, and the switch that stops it continuing on its own. */
export function OutOfUsage({ chat }: { chat: Chat }) {
  const store = useStoreInstance();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const queue = chat.queue ?? [];
  // Another signed-in account of this provider can carry on now; the user picks it, it never switches by itself.
  const accounts = useStore((s) => (chat.provider === 'claude' || chat.provider === 'codex' ? s.accounts[chat.provider] : undefined));
  const others = (accounts ?? []).filter((a) => !a.active);
  const canSwitch = chat.provider === 'claude' || chat.provider === 'codex';
  const [resets, setResets] = useState(0);
  useEffect(() => {
    if (chat.provider !== 'codex') return;
    let live = true;
    api.codexResets().then((r) => { if (live) setResets(r.available); }, () => {});
    return () => { live = false; };
  }, [chat.provider]);
  const redeemReset = async () => {
    try {
      const { outcome } = await api.useCodexReset();
      toast(outcome === 'reset' ? 'Used a free reset. Codex chats carry on now.' : outcome === 'nothingToReset' ? 'Nothing to reset right now.' : outcome === 'noCredit' ? 'No free resets left.' : "Couldn't use a free reset. Try again.");
      if (outcome === 'reset' || outcome === 'noCredit') setResets((n) => Math.max(0, n - (outcome === 'reset' ? 1 : n)));
    } catch (e) { toast(errorText(e)); }
  };
  useEffect(() => {
    if (!canSwitch || accounts) return;
    api.accounts().then((all) => store.setState((s) => ({ ...s, accounts: { ...s.accounts, ...all } })), () => {});
  }, [canSwitch, accounts, store]);
  const act = (fn: () => Promise<Chat | void>) => void runAction(store, fn);
  const save = (id: string) => { setEditing(null); if (draft.trim()) act(() => api.editQueued(chat.id, id, draft.trim())); };
  return (
    <div className="out-of-usage">
      {resets > 0 && (
        <div className="toggle-row">
          <span>{resets === 1 ? '1 free reset' : `${resets} free resets`}</span>
          <button className="btn" type="button" onClick={() => void redeemReset()}>Use reset</button>
        </div>
      )}
      {others.length > 0 && (
        <div className="switch-accounts">
          {others.map((a) => (
            <button key={a.id} className="btn" type="button" onClick={() => act(async () => {
              const list = await api.activateAccount(chat.provider as 'claude' | 'codex', a.id);
              store.setState((s) => ({ ...s, accounts: { ...s.accounts, [chat.provider]: list } }));
              await api.resumeNow(chat.id);
            })}>Switch to {a.name} and continue</button>
          ))}
        </div>
      )}
      {chat.resumeAt && (
        <div className="toggle-row">
          <span>Continue on its own when usage resets</span>
          <Switch checked={chat.autoResume !== false} label="Continue on its own when usage resets" onChange={(on) => act(() => api.patchChat(chat.id, { autoResume: on }))} />
        </div>
      )}
      {queue.length > 0 && (
        <ul className="queue" aria-label="Queued messages">
          {queue.map((q) => (
            <li key={q.id} className="queue-chip">
              {editing === q.id
                ? <input className="queue-edit" aria-label="Edit queued message" value={draft} autoFocus onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => save(q.id)} onKeyDown={(e) => { if (e.key === 'Enter') save(q.id); if (e.key === 'Escape') setEditing(null); }} />
                : <button type="button" className="queue-text" aria-label={`Edit queued message: ${q.text}`} onClick={() => { setEditing(q.id); setDraft(q.text); }}>{q.text}</button>}
              <button type="button" className="btn ghost" onClick={() => act(() => api.sendQueuedNow(chat.id, q.id))}>Send now</button>
              <button type="button" className="btn ghost icon-only" aria-label={`Remove queued message: ${q.text}`} onClick={() => act(() => api.removeQueued(chat.id, q.id))}><Icon name="x" size="sm" /></button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
/** Shown instead of the composer while a chat runs in Claude Code outside the app (#37). */
export const OUTSIDE_NOTE = 'This chat is running in Claude Code outside the app. Reply there, or continue here once it stops.';

/** The header button for the chat's state: Stop while running, Resume when stopped, Mark done in Review. */
function StateAction({ chat }: { chat: Chat }) {
  const store = useStoreInstance();
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<Chat | void>) => {
    if (busy) return;
    setBusy(true);
    await runAction(store, fn);
    setBusy(false);
  };
  const reason = chat.needsReason;
  if (chat.column === 'running' && !chat.outsideLive) {
    return <button className="btn danger" type="button" disabled={busy} onClick={() => void run(() => api.stop(chat.id))}><Icon name="stop" size="sm" />{busy ? 'Stopping…' : 'Stop'}</button>;
  }
  if (chat.column === 'needs_you' && (reason === 'stopped' || reason === 'interrupted')) {
    return <button className="btn" type="button" disabled={busy} onClick={() => void run(() => api.send(chat.id, RESUME_TEXT))}><Icon name="resume" size="sm" />Resume</button>;
  }
  if (chat.column === 'review') {
    return <button className="btn primary" type="button" disabled={busy} onClick={() => void run(() => api.done(chat.id))}><Icon name="check" size="sm" />Mark done</button>;
  }
  return null;
}

/**
 * The side panel: the same chat as in the provider's app. Opens when `ui.openChatId` (a board chat)
 * or `ui.openHistory` (a chat only in the provider's history) is set. Also hosts the chat "…" menu
 * that cards and sidebar rows open.
 */
export function ChatPanel() {
  const store = useStoreInstance();
  const openChatId = useStore((s) => s.ui.openChatId);
  const openHistory = useStore((s) => s.ui.openHistory);
  const chat = useStore((s) => (s.ui.openChatId ? s.chats[s.ui.openChatId] : undefined));
  const gone = useStore((s) => {
    const c = s.ui.openChatId ? s.chats[s.ui.openChatId] : undefined;
    return c ? isArchived(s, c) : false;
  });
  const historyUpdatedAt = useStore((s) => {
    const h = s.ui.openHistory;
    return h ? s.history.find((x) => x.provider === h.provider && x.sessionRef === h.sessionRef)?.updatedAt ?? null : null;
  });
  const now = useStore((s) => s.now);
  const project = useStore((s) => {
    const cwd = s.ui.openChatId ? s.chats[s.ui.openChatId]?.cwd : s.ui.openHistory?.cwd;
    return cwd ? projectLabel(s, cwd) : '';
  });

  const current: Shown | null = chat && !gone ? { kind: 'chat', chat } : openHistory ? { kind: 'history', ref: openHistory, updatedAt: historyUpdatedAt } : null;
  const open = current !== null;
  // What the panel last showed stays rendered while it slides out.
  const last = useRef<{ shown: Shown; project: string } | null>(null);
  if (current) last.current = { shown: current, project };
  const view = last.current;

  const panelRef = useRef<HTMLElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ target: ChatActionsTarget; anchor: HTMLElement; open: boolean } | null>(null);
  const loading = useRef(new Set<string>());
  /** Set when continuing a history chat swaps the composer for the new chat's: focus follows into it. */
  const refocus = useRef(false);
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    const active = document.activeElement;
    if (!active || active === document.body) composerRef.current?.focus({ preventScroll: true });
  });

  const close = () => store.setState(closePanelIn);

  // Cards and sidebar rows open history chats and the "…" menu through these.
  useEffect(() => {
    setHistoryHandler((ref) => store.setState((s) => openHistoryIn(s, ref)));
    setRowMenuHandler((target, anchor) => setMenu({ target, anchor, open: true }));
    return () => {
      setHistoryHandler(null);
      setRowMenuHandler(null);
    };
  }, [store]);

  // Opening a chat loads its thread once; it is not fetched again while it stays loaded.
  const known = useStore((s) => s.ui.openChatId !== null && s.ui.openChatId in s.chats);
  useEffect(() => {
    if (!openChatId || !known) return;
    if (isChatLoaded(store.getState(), openChatId) || loading.current.has(openChatId)) return;
    const id = openChatId;
    loading.current.add(id);
    loadChat(store, api, id)
      .catch((err: unknown) => toast(errorText(err)))
      .finally(() => loading.current.delete(id));
  }, [openChatId, known, store]);

  // A chat archived (here or elsewhere) closes the panel; a history chat that reached the board shows as that chat.
  useEffect(() => {
    if (openChatId && gone) store.setState(closePanelIn);
  }, [openChatId, gone, store]);
  const boardTwin = useStore((s) => {
    const h = s.ui.openHistory;
    if (!h) return null;
    return Object.values(s.chats).find((c) => c.provider === h.provider && c.sessionRef === h.sessionRef && !isArchived(s, c))?.id ?? null;
  });
  useEffect(() => {
    if (boardTwin) store.setState((s) => openChatIn(s, boardTwin));
  }, [boardTwin, store]);

  // Open: focus moves in; Escape (top-most layer) and a click on the board close it; focus returns to the opener.
  useEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel) return;
    const opener = document.activeElement instanceof HTMLElement && !panel.contains(document.activeElement) ? document.activeElement : null;
    const release = pushLayer('panel', () => store.setState(closePanelIn));
    const onBoardClick = (e: Event) => {
      const t = e.target;
      if (t instanceof Element && t.closest('.board') && !t.closest('.card')) store.setState(closePanelIn);
    };
    document.addEventListener('click', onBoardClick);
    if (!panel.contains(document.activeElement)) (composerRef.current ?? panel).focus({ preventScroll: true });
    return () => {
      release();
      document.removeEventListener('click', onBoardClick);
      const active = document.activeElement;
      if (opener?.isConnected && (panel.contains(active) || active === document.body)) opener.focus({ preventScroll: true });
    };
  }, [open, store]);

  const startRename = (id: string) => {
    store.setState((s) => openChatIn(s, id));
    setRenaming(id);
  };

  const openMenu = (e: MouseEvent<HTMLButtonElement>) => {
    if (!view) return;
    const target: ChatActionsTarget = view.shown.kind === 'chat' ? { chatId: view.shown.chat.id, history: null } : { chatId: null, history: view.shown.ref };
    setMenu({ target, anchor: e.currentTarget, open: true });
  };

  const sendTo = (c: Chat) => (text: string) => runAction(store, () => api.send(c.id, text));
  const continueHistory = (ref: HistoryRef) => async (text: string) => {
    try {
      const created = await api.continueHistory({ provider: ref.provider, sessionRef: ref.sessionRef, text });
      refocus.current = true;
      store.setState((s) => openChatIn(mergeChats(s, [created]), created.id));
      // The history list and projects still count it as history-only until they are asked again.
      void refreshHistory(store, api).catch(() => {});
      noteChatFolder(store, api, created);
      addAfterStart(store, created.cwd);
      return true;
    } catch (err) {
      toast(errorText(err));
      return false;
    }
  };

  let body = null;
  if (view) {
    const s = view.shown;
    const provider = s.kind === 'chat' ? s.chat.provider : s.ref.provider;
    const app = providerName(provider);
    const title = s.kind === 'chat' ? s.chat.title : s.ref.title;
    const editing = s.kind === 'chat' && renaming === s.chat.id;
    body = (
      <>
        <div className="panel-head">
          <ProviderLogo id={provider} size="lg" />
          <div className="t">
            {editing ? <TitleEdit chat={s.chat} onDone={() => setRenaming(null)} /> : <b id="panel-title">{title}</b>}
            <small>
              {s.kind === 'chat' && s.chat.column ? <><StatusIcon state={s.chat.column} />{STATE_TEXT[s.chat.column]}</> : lastActive(s.kind === 'history' ? s.updatedAt : null, now)}
              <span>·</span>{s.kind === 'chat' ? s.chat.model ?? app : app}
              <span>·</span><Icon name="folder" size="sm" /><span className="panel-proj">{view.project}</span>
            </small>
          </div>
          {s.kind === 'chat' && <StateAction chat={s.chat} key={s.chat.id} />}
          <Tooltip label="More">
            <button className="btn icon-only ghost" type="button" aria-label="More actions" aria-haspopup="menu" onClick={openMenu}><Icon name="more" /></button>
          </Tooltip>
          <Tooltip label="Close · Esc">
            <button className="btn icon-only ghost" type="button" aria-label="Close panel" onClick={close}><Icon name="x" /></button>
          </Tooltip>
        </div>
        <div className="panel-source">
          <span className="source"><span className="live-dot" />Same chat as in {app}</span>
        </div>
        {s.kind === 'chat' ? (
          <>
            <Thread chat={s.chat} key={`t:${s.chat.id}`} />
            {s.chat.column === 'needs_you' && s.chat.needsReason === 'limit' && <OutOfUsage chat={s.chat} />}
            {s.chat.outsideLive
              ? <p className="panel-outside" role="status">{OUTSIDE_NOTE}</p>
              : <Composer key={`c:${s.chat.id}`} ref={composerRef} onSend={sendTo(s.chat)} hint={HINT}
                placeholder={s.chat.column === 'running' ? 'Send a note. It reaches the agent after this step' : s.chat.needsReason === 'limit' ? 'Queue a message. It goes out when it can continue' : s.chat.origin === 'outside' ? 'Continue this chat here' : 'Reply or give a new instruction'} />}
          </>
        ) : (
          <>
            <HistoryThread historyRef={s.ref} app={app} key={`ht:${s.ref.provider}:${s.ref.sessionRef}`} />
            <Composer key={`h:${s.ref.provider}:${s.ref.sessionRef}`} ref={composerRef} onSend={continueHistory(s.ref)}
              hint="Sending puts this chat on the board" placeholder={`Continue this ${app} chat`} />
          </>
        )}
      </>
    );
  }

  return (
    <>
      <aside ref={panelRef} className="panel" data-state={open ? 'open' : 'closed'} aria-labelledby={view ? 'panel-title' : undefined} aria-label={view ? undefined : 'Chat'}
        inert={!open} tabIndex={-1}>
        {body}
      </aside>
      <ChatActionsMenu anchor={menu?.anchor ?? null} open={menu?.open ?? false} target={menu?.target ?? null}
        onClose={() => setMenu((m) => (m ? { ...m, open: false } : m))} onRename={startRename} />
    </>
  );
}
