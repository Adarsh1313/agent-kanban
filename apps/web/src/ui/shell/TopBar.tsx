import { focusedProvider, projectLabel, unreadCount } from '../../state/selectors.ts';
import { useStore } from '../../state/store.ts';
import { openNewChat } from '../actions.ts';
import { Icon, Tooltip, providerName, type IconName } from '../primitives/index.ts';

const VIEW_META: Record<'board' | 'projects' | 'connections', { icon: IconName; title: string }> = {
  board: { icon: 'board', title: 'Board' },
  projects: { icon: 'projects', title: 'Projects' },
  connections: { icon: 'plug', title: 'Connections' },
};

export function TopBar() {
  const view = useStore((s) => s.ui.view);
  const crumb = useStore((s) => {
    if (s.ui.view === 'board') {
      const p = focusedProvider(s);
      return p ? providerName(p) : '';
    }
    return s.ui.view === 'projects' && s.ui.projectId ? projectLabel(s, s.ui.projectId) : '';
  });
  const unread = useStore(unreadCount);
  const meta = VIEW_META[view];

  return (
    <header className="topbar">
      <h1 className="title">
        <span><Icon name={meta.icon} /></span>
        <span>{meta.title}</span>
        {crumb && <span className="crumb"> › {crumb}</span>}
      </h1>
      {view === 'board' && (
        <button className="chip-btn" type="button"><Icon name="filter" size="sm" />Filter</button>
      )}
      <span className="spacer" />
      <div className="usage-area" />
      <Tooltip label="Notifications">
        <button className="btn icon-only ghost bell" type="button" aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}>
          <Icon name="bell" /><span className="dot" data-n={unread} aria-hidden="true">{unread}</span>
        </button>
      </Tooltip>
      <button className="btn primary" type="button" aria-label="New chat" onClick={() => openNewChat()}>
        <Icon name="plus" /><span className="new-label">New chat</span> <span className="kbd">N</span>
      </button>
    </header>
  );
}
