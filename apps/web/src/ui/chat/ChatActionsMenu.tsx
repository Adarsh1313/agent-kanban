import type { Chat, ProviderId } from '@agent-kanban/shared';
import { api } from '../../api/client.ts';
import { closePanelIn, mergeChats, openHistoryIn, type AppState, type HistoryRef } from '../../state/reducer.ts';
import { useStore, useStoreInstance, type Store } from '../../state/store.ts';
import { errorText } from '../board/Card.tsx';
import { clockTime } from '../board/format.ts';
import { Icon, Menu, MenuItem, MenuLabel, MenuSep, Tooltip, toast, type MenuNav } from '../primitives/index.ts';

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

/**
 * Archive is final on the server, so the card collapses at once (client-only) and the server is only
 * asked when the Undo toast runs out. Undo restores the card without any request; a failed archive
 * brings the card back and shows the server's text.
 */
export function archiveChat(store: Store, id: string): void {
  store.setState((s) => {
    const next = { ...s, ui: { ...s.ui, archiving: { ...s.ui.archiving, [id]: true as const } } };
    return s.ui.openChatId === id ? closePanelIn(next) : next;
  });
  let undone = false;
  toast('Chat archived', { label: 'Undo', run: () => { undone = true; store.setState((s) => withoutArchiving(s, id)); } }, {
    onExpire: () => {
      if (undone) return;
      api.archive(id).then(
        (chat) => store.setState((s) => withoutArchiving(mergeChats(s, [chat]), id)),
        (err: unknown) => {
          store.setState((s) => withoutArchiving(s, id));
          toast(errorText(err));
        },
      );
    },
  });
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
  const open = wanted && target !== null && (chat !== undefined || target.history !== null);
  const history = chat ? null : target?.history ?? null;

  const pick = (fn: () => void) => () => {
    onClose();
    fn();
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
          <MenuItem icon="copy" onSelect={pick(() => void copyText(chat.cwd))}>Copy project path</MenuItem>
          {cmd && <MenuItem icon="terminal" onSelect={pick(() => void copyText(cmd))}>Copy resume command</MenuItem>}
          {onBoard && (
            <>
              <MenuSep />
              <MenuItem icon="archive" danger onSelect={pick(() => archiveChat(store, chat.id))}>Archive chat</MenuItem>
            </>
          )}
        </>
      );
    }
    if (!history) return null;
    const cmd = resumeCommand(history.provider, history.sessionRef);
    return (
      <>
        <MenuItem icon="resume" onSelect={pick(() => store.setState((s) => openHistoryIn(s, history)))}>Continue here</MenuItem>
        <MenuItem icon="copy" onSelect={pick(() => void copyText(history.cwd))}>Copy project path</MenuItem>
        {cmd && <MenuItem icon="terminal" onSelect={pick(() => void copyText(cmd))}>Copy resume command</MenuItem>}
      </>
    );
  };

  return (
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
      }}
    />
  );
}
