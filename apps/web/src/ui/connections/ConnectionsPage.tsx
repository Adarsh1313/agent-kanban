import { useState } from 'react';
import type { ConnectionHealth, ProviderId } from '@agent-kanban/shared';
import { api } from '../../api/client.ts';
import type { AppState } from '../../state/reducer.ts';
import { useStore, useStoreInstance, type Store } from '../../state/store.ts';
import { Icon, PROVIDER_IDS, ProviderLogo, providerName, toast } from '../primitives/index.ts';
import { agoLabel } from '../projects/model.ts';
import { usageSummary } from '../usage/model.ts';

const VENDOR: Record<ProviderId, string> = { claude: 'Anthropic', codex: 'OpenAI', antigravity: 'Google' };

/** Server status -> the design's card state (drives the dot colour in design/views.css) and its word. */
const STATE: Record<ConnectionHealth['status'], [string, string]> = {
  connected: ['connected', 'Connected'],
  update_available: ['connected', 'Connected'],
  signed_out: ['signedout', 'Signed out'],
  not_installed: ['missing', 'Not installed'],
  degraded: ['error', 'Needs attention'],
};

const SETUP_NEXT = 'Setup from the app is coming next.';
const ANTIGRAVITY_NEXT = 'Chats with Antigravity are coming next.';

const isConnected = (h: ConnectionHealth | undefined) => h?.status === 'connected' || h?.status === 'update_available';

/** Asks the server to check one provider again; the answer goes into the store. A failure toasts the server's text and keeps the card. */
export async function checkConnection(store: Store, provider: ProviderId): Promise<boolean> {
  try {
    const res = await api.checkConnections(provider);
    store.setState((s) => {
      const connections = { ...s.connections };
      for (const h of res) connections[h.provider] = h;
      return { ...s, connections };
    });
    return true;
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
    return false;
  }
}

const signedInText = (v: boolean | null) => (v === true ? 'Yes' : v === false ? 'No' : 'Unknown');

const cardState = (id: ProviderId) => (s: AppState) => ({
  health: s.connections[id],
  chats: s.history.filter((h) => h.provider === id).length,
  usage: usageSummary(s.usage[id], s.connections[id]?.installed === true),
  now: s.now,
  loaded: s.loaded,
});

function ConnectionCard({ id }: { id: ProviderId }) {
  const store = useStoreInstance();
  const { health, chats, usage, now, loaded } = useStore(cardState(id));
  const [checking, setChecking] = useState(false);
  const name = providerName(id);
  // No health once loaded: the server has no check for this provider yet (Antigravity in Plan 1).
  const [state, word] = health ? STATE[health.status] : ['', loaded ? 'Not connected' : 'Checking…'];
  const installed = health?.installed === true;
  const needsSetup = (!health && loaded) || health?.status === 'not_installed' || health?.status === 'signed_out';

  const check = async () => {
    if (checking) return;
    setChecking(true);
    try {
      await checkConnection(store, id);
    } finally {
      setChecking(false);
    }
  };

  return (
    <section className="conn" data-conn={id} data-state={state || undefined} aria-label={name}>
      <div className="conn-head">
        <ProviderLogo id={id} />
        <div className="t"><h4 className="conn-name">{name}</h4><small>{VENDOR[id]}</small></div>
        <span className="conn-state" role="status"><i /><span>{word}</span></span>
      </div>
      <div className="conn-body">
        {health && installed && (
          <dl className="facts">
            <dt>Version</dt>
            <dd>{health.version ?? 'Unknown'}{health.updateAvailable && health.latestVersion && <> · <span className="conn-update">Update available: {health.latestVersion}</span></>}</dd>
            <dt>Latest</dt><dd>{health.latestVersion ?? 'Unknown'}</dd>
            <dt>Signed in</dt><dd>{signedInText(health.signedIn)}</dd>
            <dt>Chats found</dt><dd>{chats}</dd>
            <dt>Usage</dt><dd>{usage}</dd>
            {health.path && <><dt>Path</dt><dd className="mono" title={health.path}>{health.path}</dd></>}
          </dl>
        )}
        {health && !installed && <span>{name} isn’t on this computer yet.</span>}
        {health?.message && <div className="conn-note"><Icon name="help" />{health.message}</div>}
        {needsSetup && <span>{SETUP_NEXT}</span>}
        {id === 'antigravity' && <span>{ANTIGRAVITY_NEXT}</span>}
      </div>
      <div className="conn-foot">
        <small className="conn-checked">{health ? `Checked ${agoLabel(health.checkedAt, now)}` : ''}</small>
        <span className="grow" />
        {/* aria-disabled, not disabled, while checking: focus stays on the button (check() ignores repeat presses). */}
        <button className="btn ghost refresh" type="button" onClick={check} aria-disabled={checking || undefined} aria-busy={checking || undefined}>
          <Icon name="refresh" size="sm" className={checking ? 'spinning' : undefined} />Check now{' '}<span className="sr-only">for {name}</span>
        </button>
      </div>
    </section>
  );
}

/** Read-only Connections: one card per coding agent. Install / Sign in / Sign out come in Plan 3. */
export function ConnectionsPage() {
  const connected = useStore((s) => PROVIDER_IDS.filter((id) => isConnected(s.connections[id])).length);
  return (
    <div className="view page connections-page">
      <div className="page-inner">
        <div className="page-head">
          <div className="t">
            <h2 className="page-title">Connections</h2>
            <p>Agent Kanban uses the agent apps on this computer. Your sign-in stays inside each app; we never see your password or tokens.</p>
          </div>
          <span className="source"><span className="live-dot" />{connected} of {PROVIDER_IDS.length} connected</span>
        </div>
        <h3 className="section-title">Coding agents</h3>
        <div className="conn-grid">
          {PROVIDER_IDS.map((id) => <ConnectionCard key={id} id={id} />)}
        </div>
      </div>
    </div>
  );
}
