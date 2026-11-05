import type { ApiKey, Chat, ProviderId, TrashEntry } from '@agent-kanban/shared';
import { useState } from 'react';
import { folderKey } from '@agent-kanban/shared';
import { chatFolder, visibleProjects } from '../../state/selectors.ts';
import { api } from '../../api/client.ts';
import { closePanelIn, mergeChats, openHistoryIn, type AppState, type HistoryRef } from '../../state/reducer.ts';
import { useStore, useStoreInstance, type Store } from '../../state/store.ts';
import { errorText } from '../board/Card.tsx';
import { clockTime } from '../board/format.ts';
import { dismissToast, Icon, Menu, MenuItem, MenuLabel, MenuSep, Tooltip, toast, type MenuNav } from '../primitives/index.ts';
import { Dialog } from '../primitives/Dialog.tsx';
import { capReached, UseKeyDialog, useKeys } from '../connections/ApiKeys.tsx';

const HOUR = 3_600_000;
const EVENING_HOUR = 18;
const MORNING_HOUR = 9;
const MONDAY = 1;

/** Runs a chat action; the server's reply goes into the store, a failure shows the server's text and changes nothing. */
export async function runAction(store: Store, run: () => Promise<Chat | void>): Promise<boolean> {
  try {
    const chat = await run();
    if (chat) store.setState((s) => mergeChats(s, [chat]));
    return true;
  } catch (err) {
    toast(errorText(err));
    return false;
  }
}

/** Shows the project folder in the file manager; a failure (moved, deleted) toasts the server's reason. */
export async function openFolder(path: string): Promise<void> {
  try {
    await api.openFolder(path);
  } catch (err) {
    toast(errorText(err));
  }
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
  } catch {
    toast('Couldn’t copy');
  }
}

/** The command that resumes this chat in the provider's own CLI (none for Antigravity). */
export function resumeCommand(provider: ProviderId, sessionRef: string | null): string | null {
  if (!sessionRef) return null;
  if (provider === 'claude') return `claude --resume ${sessionRef}`;
  if (provider === 'codex') return `codex resume ${sessionRef}`;
  return null;
}

export interface SnoozeOption { label: string; until: Date; when: string }

/** Snooze choices in the user's local time. "This evening" (18:00 today) is left out once it has passed. */
export function snoozeOptions(now: Date = new Date()): SnoozeOption[] {
  const at = (days: number, hour: number) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, hour, 0, 0, 0);
    return d;
  };
  const time = (d: Date) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase();
  const out: SnoozeOption[] = [];
  const hour = new Date(now.getTime() + HOUR);
  out.push({ label: 'In 1 hour', until: hour, when: clockTime(hour.toISOString(), now.getTime()) });
  const evening = at(0, EVENING_HOUR);
  if (now < evening) out.push({ label: 'This evening', until: evening, when: time(evening) });
  const tomorrow = at(1, MORNING_HOUR);
  out.push({ label: 'Tomorrow morning', until: tomorrow, when: `Tomorrow ${time(tomorrow)}` });
  const toMonday = ((MONDAY - now.getDay() + 7) % 7) || 7;
  const monday = at(toMonday, MORNING_HOUR);
  out.push({ label: 'Next Monday', until: monday, when: `Mon ${monday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time(monday)}` });
  return out;
}

const withoutArchiving = (s: AppState, id: string): AppState => {
  if (!s.ui.archiving[id]) return s;
  const { [id]: _gone, ...rest } = s.ui.archiving;
  return { ...s, ui: { ...s.ui, archiving: rest } };
};

interface PendingArchive { store: Store; toastId: number }

/** Archives waiting for their Undo toast to run out, by chat id. An entry is removed by Undo or when it is sent, so it is sent once. */
const pendingArchives = new Map<string, PendingArchive>();
let pagehideBound = false;

function sendArchive(store: Store, id: string, keepalive: boolean): void {
  api.archive(id, keepalive ? { keepalive: true } : {}).then(
    (chat) => store.setState((s) => withoutArchiving(mergeChats(s, [chat]), id)),
    (err: unknown) => {
      store.setState((s) => withoutArchiving(s, id));
      toast(errorText(err));
    },
  );
}

/** The page is going away: archives still in their Undo window are sent now (keepalive) instead of being lost. */
function onPagehide(): void {
  for (const [id, p] of [...pendingArchives]) {
    pendingArchives.delete(id);
    sendArchive(p.store, id, true);
    // The archive has been sent: if the page lives on (back/forward cache, or a pagehide that did not unload), its Undo would be dead.
    dismissToast(p.toastId);
  }
}

/**
 * Archive is final on the server, so the card collapses at once (client-only) and the server is only
 * asked when the Undo toast runs out, or when the page closes first. Undo restores the card without
 * any request; a failed archive brings the card back and shows the server's text.
 */
export function archiveChat(store: Store, id: string): void {
  if (!pagehideBound) {
    window.addEventListener('pagehide', onPagehide);
    pagehideBound = true;
  }
  store.setState((s) => {
    const next = { ...s, ui: { ...s.ui, archiving: { ...s.ui.archiving, [id]: true as const } } };
    return s.ui.openChatId === id ? closePanelIn(next) : next;
  });
  const toastId = toast('Chat archived', {
    label: 'Undo',
    run: () => {
      if (!pendingArchives.delete(id)) return;
      store.setState((s) => withoutArchiving(s, id));
    },
  }, {
    onExpire: () => {
      if (pendingArchives.delete(id)) sendArchive(store, id, false);
    },
  });
  pendingArchives.set(id, { store, toastId });
}

export async function unarchiveChat(store: Store, id: string): Promise<void> {
  const ok = await runAction(store, () => api.unarchive(id));
  if (ok) toast('Chat unarchived');
}

const setHistoryArchive = (s: AppState, provider: ProviderId, sessionRef: string, archived: boolean): AppState => ({
  ...s,
  history: s.history.map((h) => h.provider === provider && h.sessionRef === sessionRef ? { ...h, archived } : h),
});

export async function archiveHistoryChat(store: Store, history: HistoryRef): Promise<void> {
  store.setState((s) => setHistoryArchive(s, history.provider, history.sessionRef, true));
  try {
    await api.archiveHistory(history.provider, history.sessionRef);
    toast('Chat archived', {
      label: 'Undo',
      run: () => {
        store.setState((s) => setHistoryArchive(s, history.provider, history.sessionRef, false));
        void api.unarchiveHistory(history.provider, history.sessionRef).catch((err: unknown) => {
          store.setState((s) => setHistoryArchive(s, history.provider, history.sessionRef, true));
          toast(errorText(err));
        });
      },
    });
  } catch (err) {
    store.setState((s) => setHistoryArchive(s, history.provider, history.sessionRef, false));
    toast(errorText(err));
  }
}

export async function unarchiveHistoryChat(store: Store, history: HistoryRef): Promise<void> {
  try {
    await api.unarchiveHistory(history.provider, history.sessionRef);
    store.setState((s) => setHistoryArchive(s, history.provider, history.sessionRef, false));
    toast('Chat unarchived');
  } catch (err) {
    toast(errorText(err));
  }
}

export async function snoozeChat(store: Store, id: string, opt: SnoozeOption): Promise<void> {
  const ok = await runAction(store, () => api.patchChat(id, { snoozedUntil: opt.until.toISOString() }));
  if (ok) toast(`Snoozed until ${opt.when}`, { label: 'Undo', run: () => void runAction(store, () => api.patchChat(id, { snoozedUntil: null })) });
}

export async function togglePin(store: Store, chat: Chat): Promise<void> {
  const ok = await runAction(store, () => api.patchChat(chat.id, { pinned: !chat.pinned }));
  if (ok) toast(chat.pinned ? 'Unpinned' : 'Pinned to the sidebar');
}

export interface ChatActionsTarget { chatId: string | null; history: HistoryRef | null }

export interface ChatActionsMenuProps {
  anchor: HTMLElement | null;
  open: boolean;
  /** Kept after closing so the menu can animate out with its content. */
  target: ChatActionsTarget | null;
  onClose: () => void;
  /** Starts the inline title edit for this chat (in the side panel). */
  onRename: (chatId: string) => void;
}

/** The chat "…" menu: on cards, sidebar rows and the panel header. History-only chats get the items that make sense for them. */
export function ChatActionsMenu({ anchor, open: wanted, target, onClose, onRename }: ChatActionsMenuProps) {
  const store = useStoreInstance();
  const chat = useStore((s) => (target?.chatId ? s.chats[target.chatId] : undefined));
  const projects = useStore((s) => visibleProjects(s));
  const open = wanted && target !== null && (chat !== undefined || target.history !== null);
  const history = chat ? null : target?.history ?? null;
  const historyArchived = useStore((s) => history !== null && Boolean(s.history.find((h) => h.provider === history.provider && h.sessionRef === history.sessionRef)?.archived));
  const historyOpen = useStore((s) => history !== null && s.ui.openHistory?.provider === history.provider && s.ui.openHistory.sessionRef === history.sessionRef);
  const [deleting, setDeleting] = useState<ChatActionsTarget | null>(null);
  // "Continue with API key" (#43): the chat's provider's keys, picked here or from the out-of-usage nudge.
  const keys = useKeys();
  const [usingKey, setUsingKey] = useState<{ chat: Chat; key: ApiKey } | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);

  const pick = (fn: () => void) => () => {
    onClose();
    fn();
  };

  const askDelete = (item: ChatActionsTarget) => {
    onClose();
    setDeleting(item);
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeletingBusy(true);
    try {
      let entry: TrashEntry;
      if (deleting.chatId) entry = await api.deleteChat(deleting.chatId);
      else if (deleting.history) entry = await api.deleteHistory(deleting.history.provider, deleting.history.sessionRef);
      else return;
      store.setState((s) => ({
        ...s,
        chats: entry.chatId && s.chats[entry.chatId] ? { ...s.chats, [entry.chatId]: { ...s.chats[entry.chatId]!, deletedAt: entry.deletedAt } } : s.chats,
        history: deleting.history ? s.history.filter((h) => h.provider !== deleting.history!.provider || h.sessionRef !== deleting.history!.sessionRef) : s.history,
        trash: [entry, ...s.trash.filter((e) => e.id !== entry.id)],
      }));
      setDeleting(null);
      toast('Chat moved to Trash');
    } catch (err) { toast(errorText(err)); }
    finally { setDeletingBusy(false); }
  };

  const root = (nav: MenuNav) => {
    if (chat) {
      const cmd = resumeCommand(chat.provider, chat.sessionRef);
      const onBoard = chat.column !== null;
      return (
        <>
          {onBoard && chat.column !== 'done' && <MenuItem icon="check" onSelect={pick(() => void runAction(store, () => api.done(chat.id)))}>Mark done</MenuItem>}
          <MenuItem icon="pin" onSelect={pick(() => void togglePin(store, chat))}>{chat.pinned ? 'Unpin' : 'Pin to sidebar'}</MenuItem>
          {onBoard && chat.column !== 'done' && (
            <MenuItem icon="snooze" right={<Icon name="chevron-right" size="sm" />} onSelect={() => nav.go('snooze')}>Snooze</MenuItem>
          )}
          <MenuItem icon="rename" onSelect={pick(() => onRename(chat.id))}>Rename</MenuItem>
          {onBoard && chat.column !== 'running' && (keys ?? []).filter((k) => k.provider === chat.provider && k.id !== chat.keyId && !capReached(k)).map((k) => (
            <MenuItem key={k.id} icon="resume" onSelect={pick(() => setUsingKey({ chat, key: k }))}>Continue with API key '{k.name}'</MenuItem>
          ))}
          {onBoard && chat.keyId && chat.column !== 'running' && (
            <MenuItem icon="resume" onSelect={pick(() => void runAction(store, () => api.useKey(chat.id, null)))}>Use my plan again</MenuItem>
          )}
          <MenuItem icon="folder" right={<Icon name="chevron-right" size="sm" />} onSelect={() => nav.go('move')}>Move to project</MenuItem>
          <MenuItem icon="folder" onSelect={pick(() => void openFolder(chat.cwd))}>Open folder</MenuItem>
          <MenuItem icon="copy" onSelect={pick(() => void copyText(chat.cwd))}>Copy project path</MenuItem>
          {cmd && <MenuItem icon="terminal" onSelect={pick(() => void copyText(cmd))}>Copy resume command</MenuItem>}
          {(onBoard || chat.archived) && (
            <>
              <MenuSep />
              {chat.archived
                ? <MenuItem icon="archive" onSelect={pick(() => void unarchiveChat(store, chat.id))}>Unarchive chat</MenuItem>
                : <MenuItem icon="archive" danger onSelect={pick(() => archiveChat(store, chat.id))}>Archive chat</MenuItem>}
            </>
          )}
          <MenuSep />
          <MenuItem icon="trash" danger disabled={chat.column === 'running' || chat.provider === 'antigravity'}
            right={chat.column === 'running' ? 'Stop it first' : chat.provider === 'antigravity' ? "Antigravity chats can't be deleted from here yet" : undefined}
            onSelect={() => askDelete({ chatId: chat.id, history: null })}>Delete chat</MenuItem>
        </>
      );
    }
    if (!history) return null;
    const cmd = resumeCommand(history.provider, history.sessionRef);
    return (
      <>
        {!historyOpen && <MenuItem icon="resume" onSelect={pick(() => store.setState((s) => openHistoryIn(s, history)))}>Continue here</MenuItem>}
        <MenuItem icon="folder" onSelect={pick(() => void openFolder(history.cwd))}>Open folder</MenuItem>
        <MenuItem icon="copy" onSelect={pick(() => void copyText(history.cwd))}>Copy project path</MenuItem>
        {cmd && <MenuItem icon="terminal" onSelect={pick(() => void copyText(cmd))}>Copy resume command</MenuItem>}
        <MenuSep />
        {historyArchived
          ? <MenuItem icon="archive" onSelect={pick(() => void unarchiveHistoryChat(store, history))}>Unarchive chat</MenuItem>
          : <MenuItem icon="archive" danger onSelect={pick(() => void archiveHistoryChat(store, history))}>Archive chat</MenuItem>}
        <MenuItem icon="trash" danger disabled={history.provider === 'antigravity'} right={history.provider === 'antigravity' ? "Antigravity chats can't be deleted from here yet" : undefined}
          onSelect={() => askDelete({ chatId: null, history })}>Delete chat</MenuItem>
      </>
    );
  };

  return (
    <>
    <Menu
      anchor={anchor}
      open={open}
      onClose={onClose}
      align="right"
      label="Chat actions"
      panes={{
        root,
        snooze: (nav) => (
          <>
            <MenuLabel>
              <Tooltip label="Back">
                <button className="btn icon-only ghost menu-back" type="button" aria-label="Back" onClick={nav.back}><Icon name="back" size="sm" /></button>
              </Tooltip>
              Snooze until
            </MenuLabel>
            {chat && snoozeOptions(new Date()).map((o) => (
              <MenuItem key={o.label} right={o.when} onSelect={pick(() => void snoozeChat(store, chat.id, o))}>{o.label}</MenuItem>
            ))}
          </>
        ),
        move: (nav) => (
          <>
            <MenuLabel>
              <Tooltip label="Back">
                <button className="btn icon-only ghost menu-back" type="button" aria-label="Back" onClick={nav.back}><Icon name="back" size="sm" /></button>
              </Tooltip>
              Move to project
            </MenuLabel>
            {chat && projects.filter((p) => folderKey(p.path) !== folderKey(chatFolder(chat))).map((p) => (
              <MenuItem key={p.id} onSelect={pick(() => void moveToProject(store, chat, p.path))}>{p.name || p.path}</MenuItem>
            ))}
            {chat?.projectLabel && <MenuItem onSelect={pick(() => void moveToProject(store, chat, null))}>Back to its own folder</MenuItem>}
          </>
        ),
      }}
    />
    <Dialog open={deleting !== null} onClose={() => { if (!deletingBusy) setDeleting(null); }} title="Delete this chat?"
      footer={<><span className="grow" /><button className="btn ghost" type="button" disabled={deletingBusy} onClick={() => setDeleting(null)}>Cancel</button>
        <button className="btn danger" type="button" disabled={deletingBusy} onClick={() => void confirmDelete()}>Delete chat</button></>}>
      <p>It goes to Trash for 30 days, then it’s gone for good.</p>
    </Dialog>
    {usingKey && <UseKeyDialog chat={usingKey.chat} k={usingKey.key} onClose={() => setUsingKey(null)} />}
    </>
  );
}

/** Move to project (#40): a label only. The chat shows under the project and keeps running in its own folder. */
export async function moveToProject(store: Store, chat: Chat, path: string | null): Promise<void> {
  const ok = await runAction(store, () => api.patchChat(chat.id, { projectLabel: path }));
  if (ok && path) toast(`Moved. It still runs in ${chat.cwd}`);
}
