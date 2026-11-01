import type { ProviderId } from '@agent-kanban/shared';
import type { KeyboardEvent, MouseEvent } from 'react';
import type { SidebarChat } from '../../state/selectors.ts';
import { projectLabel } from '../../state/selectors.ts';
import { openChatIn } from '../../state/reducer.ts';
import { useStore, useStoreInstance } from '../../state/store.ts';
import { openHistoryChat, openRowMenu } from '../actions.ts';
import { Icon, ProviderLogo, StatusIcon, Tooltip, providerName } from '../primitives/index.ts';
import { dateTime, relativeTime } from '../board/format.ts';

export function onActivate(fn: () => void) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
      e.preventDefault();
      fn();
    }
  };
}

interface RowChat { key: string; chatId: string | null; provider: ProviderId; sessionRef: string | null; title: string; cwd: string; updatedAt: string; column: SidebarChat['column'] }

/**
 * A sidebar chat row (Pinned, and the chats on a My projects card): provider logo, title, running / needs-you mark, then
 * the project label (left out on a project's own card) that hover swaps for the date, and a More actions button.
 */
export function ChatRow({ chat, current, project: given, hideProject = false }: { chat: RowChat; current: boolean; project?: string; hideProject?: boolean }) {
  const store = useStoreInstance();
  const now = useStore((s) => s.now);
  const project = useStore((s) => given ?? projectLabel(s, chat.cwd));
  // Hover shows the full title plus its project, provider and when it was last active (#23); the row swaps the project label for the date.
  const when = `${project} · ${providerName(chat.provider)} · ${dateTime(chat.updatedAt, now)}`;
  const open = () => {
    if (chat.chatId) store.setState((s) => openChatIn(s, chat.chatId!));
    else if (chat.sessionRef) openHistoryChat({ provider: chat.provider, sessionRef: chat.sessionRef, cwd: chat.cwd, title: chat.title });
  };
  const more = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    openRowMenu(
      { chatId: chat.chatId, history: chat.sessionRef ? { provider: chat.provider, sessionRef: chat.sessionRef, cwd: chat.cwd, title: chat.title } : null },
      e.currentTarget,
    );
  };
  return (
    <div className="chat-row" role="button" tabIndex={0} title={`${chat.title}
${when}`} aria-description={when} aria-current={current ? 'true' : undefined} onClick={open} onKeyDown={onActivate(open)}>
      <ProviderLogo id={chat.provider} size="sm" />
      <span className="t">{chat.title}</span>
      {chat.column === 'running' && <StatusIcon state="running" />}
      {chat.column === 'needs_you' && <span className="state-dot" title="Needs you" />}
      <span className="rest" aria-hidden="true">{!hideProject && <span className="p">{project}</span>}<span className="d">{relativeTime(chat.updatedAt, now)}</span></span>
      <Tooltip label="More actions">
        <button className="row-more" type="button" aria-label={`More actions for ${chat.title}`} aria-haspopup="menu" onClick={more}>
          <Icon name="more" size="sm" />
        </button>
      </Tooltip>
    </div>
  );
}
