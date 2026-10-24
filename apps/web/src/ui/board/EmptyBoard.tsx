import type { HistoryChat } from '@agent-kanban/shared';
import { memoState, projectLabel } from '../../state/selectors.ts';
import { useStore } from '../../state/store.ts';
import { openHistoryChat, openNewChat } from '../actions.ts';
import { Icon, ProviderLogo } from '../primitives/index.ts';
import { navigate } from '../shell/route.ts';
import { relativeTime } from './format.ts';

const RECENT_SHOWN = 3;

/** The latest provider-history chats that are not on the board yet (the design's "pick up where you left off"). */
const recentHistory = memoState((s) => [s.chats, s.history], (s): HistoryChat[] => {
  const known = new Set(Object.values(s.chats).filter((c) => c.sessionRef).map((c) => `${c.provider}\u0000${c.sessionRef}`));
  return s.history
    .filter((h) => !known.has(`${h.provider}\u0000${h.sessionRef}`))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
    .slice(0, RECENT_SHOWN);
});

const noAgentConnected = (s: Parameters<typeof recentHistory>[0]) => {
  const known = Object.values(s.connections);
  // Before the first check there is nothing to go on: assume connected rather than nag.
  return known.length > 0 && !known.some((c) => c?.status === 'connected' || c?.status === 'update_available');
};

const Art = () => <div className="empty-art" aria-hidden="true"><i /><i /><i /><i /></div>;

/** Shown over the dimmed columns when nothing is on the board and no filter is set. */
export function EmptyBoard() {
  const history = useStore(recentHistory);
  const labels = useStore((s) => history.map((h) => projectLabel(s, h.cwd)));
  const now = useStore((s) => s.now);
  const disconnected = useStore(noAgentConnected);

  if (disconnected) {
    return (
      <div className="board-empty" role="region" aria-label="Empty board">
        <Art />
        <h2>Connect an agent to get started</h2>
        <p>Agent Kanban runs the coding agents already on this computer. Connect Claude Code, Codex or Antigravity and your board fills up as they work.</p>
        <div className="acts"><button className="btn primary" type="button" onClick={() => navigate('connections')}><Icon name="plug" size="sm" />Connect an agent</button></div>
      </div>
    );
  }
  return (
    <div className="board-empty" role="region" aria-label="Empty board">
      <Art />
      <h2>Nothing on the board yet</h2>
      <p>Start a chat and it shows up in Running, then moves across the board on its own as the agent works.</p>
      <div className="acts">
        <button className="btn primary" type="button" onClick={() => openNewChat()}><Icon name="plus" size="sm" />Start a chat <span className="kbd">N</span></button>
        <button className="btn ghost" type="button" onClick={() => navigate('projects')}><Icon name="projects" size="sm" />Browse projects</button>
      </div>
      {history.length > 0 && (
        <div className="recent">
          <div className="k">OR PICK UP WHERE YOU LEFT OFF</div>
          {history.map((h, i) => (
            <button key={`${h.provider}:${h.sessionRef}`} className="rc" type="button"
              onClick={() => openHistoryChat({ provider: h.provider, sessionRef: h.sessionRef, cwd: h.cwd, title: h.title })}>
              <ProviderLogo id={h.provider} size="sm" /><span className="t">{h.title}</span><small>{labels[i]} · {relativeTime(h.updatedAt, now)}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
