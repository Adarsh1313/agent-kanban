import { focusedProvider } from '../../state/selectors.ts';
import { useStore } from '../../state/store.ts';
import { openNewChat } from '../actions.ts';
import { Icon, providerName, type IconName } from '../primitives/index.ts';
import { Bell } from '../notify/Bell.tsx';
import { FilterButton } from '../filters/FilterMenu.tsx';
import { UsageChips } from '../usage/UsageChips.tsx';

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
    // The Projects page has its own breadcrumb (design/projects.js clears the top bar's).
    return '';
  });
  const meta = VIEW_META[view];

  return (
    <header className="topbar">
      <h1 className="title">
        <span><Icon name={meta.icon} /></span>
        <span>{meta.title}</span>
        {crumb && <span className="crumb"> › {crumb}</span>}
      </h1>
      {view === 'board' && (
        <FilterButton />
      )}
      <span className="spacer" />
      <div className="usage-area"><UsageChips /></div>
      <Bell />
      <button className="btn primary" type="button" aria-label="New chat" onClick={() => openNewChat()}>
        <Icon name="plus" /><span className="new-label">New chat</span> <span className="kbd">N</span>
      </button>
    </header>
  );
}
