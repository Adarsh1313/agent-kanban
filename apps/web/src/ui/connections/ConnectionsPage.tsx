import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import type { ConnectionHealth, ConnectState, ProviderId } from '@agent-kanban/shared';
import { api, type ConnectAction } from '../../api/client.ts';
import { applyEvent, applySettings, mergeConnect, type AppState } from '../../state/reducer.ts';
import { refreshHistory, refreshProjects, useStore, useStoreInstance, type Store } from '../../state/store.ts';
import { Icon, Popover, PROVIDER_IDS, ProviderLogo, providerName, StatusIcon, SwapText, Switch, toast } from '../primitives/index.ts';
import { cssMs, reducedMotion } from '../primitives/motion.ts';
import { agoLabel } from '../projects/model.ts';
import { usageSummary } from '../usage/model.ts';

const VENDOR: Record<ProviderId, string> = { claude: 'Anthropic', codex: 'OpenAI', antigravity: 'Google' };
/** Where the user signs in (design/connections.js). */
const SIGN_IN_ON: Record<ProviderId, string> = { claude: 'claude.ai', codex: 'chatgpt.com', antigravity: 'your Google account' };
export const OPENED: Record<ProviderId, string> = { claude: 'claude.ai', codex: 'chatgpt.com', antigravity: 'Google sign-in' };
/** Notes shown on a connected card (design/connections.js). */
const NOTE: Partial<Record<ProviderId, string>> = {
  claude: 'Runs Claude Code on this computer with your own sign-in. Anthropic’s rules for using a subscription in other apps changed several times in 2026, so check their current terms.',
  antigravity: 'Usage limits show only when Antigravity reports them itself.',
};
const ANTIGRAVITY_SERVER = 'Uses Google’s official Antigravity server.';
/** Antigravity's agent takes minutes to start the first time (shown while it installs or starts for a sign-in). */
export const ANTIGRAVITY_SLOW = 'This can take a couple of minutes the first time.';
/** The server's step while Antigravity's agent starts (STEP_STARTING_ANTIGRAVITY); the slow note goes with it only. */
const STARTING_ANTIGRAVITY = 'Starting Antigravity…';

/**
 * Antigravity's sign-in before the agent printed its link (it is still starting): the server's step is shown,
 * not "Finish signing in", and nothing says the browser was opened yet (the agent opens it with the link).
 */
export const antigravityStarting = (id: ProviderId, c: ConnectState | undefined) => id === 'antigravity' && c?.phase === 'signing_in' && !c.signInUrl;

/**
 * What a card shows. The server's operation (ConnectState) wins while one runs; otherwise the health check decides.
 * `dot` is the design's data-state (it colours the status dot in design/views.css).
 */
export type View = 'checking' | 'unknown' | 'connected' | 'degraded' | 'missing' | 'signedout' | 'installing' | 'updating' | 'signin' | 'signingout' | 'error';
const VIEW: Record<View, { dot: string | undefined; word: string }> = {
  checking: { dot: undefined, word: 'Checking…' },
  unknown: { dot: undefined, word: 'Not connected' },
  connected: { dot: 'connected', word: 'Connected' },
  degraded: { dot: 'error', word: 'Needs attention' },
  missing: { dot: 'missing', word: 'Not installed' },
  signedout: { dot: 'signedout', word: 'Signed out' },
  installing: { dot: 'installing', word: 'Installing' },
  updating: { dot: 'installing', word: 'Updating' },
  signin: { dot: 'signin', word: 'Waiting for sign-in' },
  signingout: { dot: 'installing', word: 'Signing out' },
  error: { dot: 'error', word: 'Needs attention' },
};

export const isConnected = (h: ConnectionHealth | undefined) => h?.status === 'connected' || h?.status === 'update_available';

function healthView(h: ConnectionHealth | undefined, loaded: boolean): View {
  if (!h) return loaded ? 'unknown' : 'checking';
  switch (h.status) {
    case 'connected': case 'update_available': return 'connected';
    case 'signed_out': return 'signedout';
    case 'not_installed': return 'missing';
    case 'degraded': return 'degraded';
  }
}

export function cardView(h: ConnectionHealth | undefined, c: ConnectState | undefined, loaded: boolean): View {
  switch (c?.phase) {
    case 'installing': return 'installing';
    case 'updating': return 'updating';
    case 'signing_in': return 'signin';
    case 'signing_out': return 'signingout';
    // A failed update or sign-out leaves a working connection: the card stays connected and shows the message.
    case 'error': return isConnected(h) ? 'connected' : 'error';
    default:
      // Just finished (done): the health on hand predates it, so wait for the check the server runs next.
      if (c?.phase === 'idle' && c.outcome === 'done' && h && Date.parse(c.updatedAt) > Date.parse(h.checkedAt)) return 'checking';
      return healthView(h, loaded);
  }
}

/** Try again re-runs what failed; without a record of it, the next step the health check points to. */
export function retryAction(connect: ConnectState | undefined, health: ConnectionHealth | undefined): ConnectAction {
  const lastOp = connect?.lastOp ?? null;
  return lastOp === 'install' || lastOp === 'update' || lastOp === 'signin' ? lastOp : health?.installed === true ? 'signin' : 'install';
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const RUNNING = new Set(['installing', 'updating', 'signing_in', 'signing_out']);

/**
 * The toast for an operation that just finished, seen live (an event moving a running phase to idle with
 * outcome 'done'); null otherwise. Never used for loads or resyncs, so a finished operation is not announced twice.
 */
export function connectDoneToast(prev: ConnectState | undefined, next: ConnectState, health: ConnectionHealth | undefined): string | null {
  if (!prev || !RUNNING.has(prev.phase) || next.phase !== 'idle' || next.outcome !== 'done') return null;
  if (Date.parse(next.updatedAt) < Date.parse(prev.updatedAt)) return null; // an older state the store ignores
  const name = providerName(next.provider);
  switch (next.lastOp) {
    case 'signin': return `${name} is connected. Its chats now show in the sidebar and All chats`;
    case 'update': return health?.latestVersion ? `${name} updated to ${health.latestVersion}` : `${name} updated`;
    case 'signout': return `Signed out of ${name}`;
    default: return null;
  }
}

/** Antigravity opens the browser itself when its link arrives: that is when "Opened Google sign-in" is true. */
export function signInLinkToast(prev: ConnectState | undefined, next: ConnectState): string | null {
  if (next.provider !== 'antigravity' || next.phase !== 'signing_in' || !next.signInUrl || prev?.signInUrl) return null;
  if (prev && Date.parse(next.updatedAt) < Date.parse(prev.updatedAt)) return null;
  return `Opened ${OPENED[next.provider]} in your browser`;
}

/** Applies a live connect.updated event, toasting an operation that just finished (or Antigravity's opened sign-in). */
export function applyConnectEvent(store: Store, state: ConnectState): void {
  const s = store.getState();
  const prev = s.connect[state.provider];
  const text = connectDoneToast(prev, state, s.connections[state.provider]) ?? signInLinkToast(prev, state);
  store.setState((cur) => applyEvent(cur, { type: 'connect.updated', state }));
  if (text) toast(text);
}

/** Asks the server to check one provider again; the answer goes into the store. A failure toasts the server's text and keeps the card. */
export async function checkConnection(store: Store, provider: ProviderId): Promise<ConnectionHealth[] | null> {
  try {
    const res = await api.checkConnections(provider);
    store.setState((s) => {
      const connections = { ...s.connections };
      for (const h of res) connections[h.provider] = h;
      return { ...s, connections };
    });
    return res;
  } catch (e) {
    toast(errText(e));
    return null;
  }
}

/** Starts (or cancels) an operation for a provider. The answer goes into the store; a refusal (busy, …) toasts the server's text. */
export async function runConnect(store: Store, provider: ProviderId, action: ConnectAction): Promise<boolean> {
  try {
    const st = await api.connect(provider, action);
    store.setState((s) => ({ ...s, connect: mergeConnect(s.connect, [st]) }));
    return true;
  } catch (e) {
    toast(errText(e));
    return false;
  }
}

/** Turns "Show its chats" / "Suggest it" on or off; the lists those change are fetched again. */
export async function setProviderSetting(store: Store, provider: ProviderId, key: 'showChats' | 'suggest', on: boolean): Promise<boolean> {
  try {
    const settings = await api.patchSettings({ [key]: { [provider]: on } });
    store.setState((s) => applySettings(s, settings));
    if (key === 'showChats') {
      // The server filters history (and so the projects built from it) by this switch. Not awaited: the switch is free
      // again as soon as the setting is saved; the refreshes drop answers that a later refresh overtook.
      void refreshHistory(store, api).catch(() => { /* the next resync fetches it */ });
      void refreshProjects(store, api).catch(() => { /* the next resync fetches them */ });
    }
    return true;
  } catch (e) {
    toast(errText(e));
    return false;
  }
}

/**
 * Runs Install / Sign in / Cancel / … for one provider (shared by the Connections cards and onboarding's Connect rows):
 * one request at a time, its button aria-disabled while it is in flight, and the design's "Opened … in your browser" toasts.
 */
export function useConnectRun(id: ProviderId) {
  const store = useStoreInstance();
  /** The action whose request is in flight (its button is aria-disabled; repeat presses are ignored). */
  const [pending, setPending] = useState<ConnectAction | null>(null);
  const run = async (action: ConnectAction) => {
    if (pending) return;
    setPending(action);
    try {
      const ok = await runConnect(store, id, action);
      if (ok && action === 'open') toast('Opened the sign-in page again');
      // Antigravity's agent opens the browser once it has started: toasted when its link arrives (applyConnectEvent).
      if (ok && action === 'signin' && id !== 'antigravity') toast(`Opened ${OPENED[id]} in your browser`);
    } finally {
      setPending(null);
    }
  };
  const busyProps = (action: ConnectAction) => ({
    'aria-disabled': pending === action || undefined,
    'aria-busy': pending === action || undefined,
    onClick: () => void run(action),
  });
  return { pending, run, busyProps };
}

type ToggleKey = 'showChats' | 'suggest';

/**
 * Saves "Show its chats" / "Suggest it" for one provider. One request at a time per switch, and the latest click wins:
 * a click while a save is in flight is remembered and saved when that one finishes (if it differs). `intent` is what
 * the user last asked for while saving, so the switch follows the click at once.
 */
export function useProviderToggle(id: ProviderId) {
  const store = useStoreInstance();
  const st = useRef<Record<ToggleKey, { busy: boolean; want: boolean | null }>>({ showChats: { busy: false, want: null }, suggest: { busy: false, want: null } });
  const [intent, setIntent] = useState<Partial<Record<ToggleKey, boolean>>>({});
  const toggle = async (key: ToggleKey, on: boolean) => {
    const k = st.current[key];
    k.want = on;
    setIntent((i) => ({ ...i, [key]: on }));
    if (k.busy) return;
    k.busy = true;
    try {
      let sent: boolean | null = null;
      while (k.want !== null && k.want !== sent) {
        sent = k.want;
        if (!(await setProviderSetting(store, id, key, sent))) break;
      }
    } finally {
      k.busy = false;
      k.want = null;
      setIntent((i) => {
        const next = { ...i };
        delete next[key];
        return next;
      });
    }
  };
  return { toggle, intent };
}

const signedInText = (v: boolean | null) => (v === true ? 'Yes' : v === false ? 'No' : 'Unknown');

const cardState = (id: ProviderId) => (s: AppState) => ({
  health: s.connections[id],
  connect: s.connect[id],
  showChats: s.settings ? s.settings.showChats[id] !== false : null,
  suggest: s.settings ? s.settings.suggest[id] !== false : null,
  chats: s.history.filter((h) => h.provider === id).length,
  usage: usageSummary(s.usage[id], s.connections[id]?.installed === true),
  now: s.now,
  loaded: s.loaded,
});

/** The install / update progress bar: scaleX via --p (design/views.css); no value when it can't be measured. */
function Progress({ value, label, step }: { value: number | null; label: string; step: string }) {
  const p = value === null ? 0 : Math.max(0, Math.min(1, value));
  return (
    <div className="progress" role="progressbar" aria-label={label} aria-valuetext={step} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value === null ? undefined : Math.round(p * 100)}>
      <i style={{ '--p': p } as CSSProperties} />
    </div>
  );
}

function ConnectionCard({ id }: { id: ProviderId }) {
  const store = useStoreInstance();
  const { health, connect, showChats, suggest, chats, usage, now, loaded } = useStore(cardState(id));
  const [checking, setChecking] = useState(false);
  const [upToDate, setUpToDate] = useState(false);
  const { run, busyProps } = useConnectRun(id);
  const { toggle, intent } = useProviderToggle(id);
  const [confirm, setConfirm] = useState(false);
  const signOutRef = useRef<HTMLButtonElement>(null);
  const name = providerName(id);
  const view = cardView(health, connect, loaded);
  const { dot, word } = VIEW[view];
  const installed = health?.installed === true;
  const phase = connect?.phase ?? 'idle';
  const message = phase === 'idle' || phase === 'error' ? connect?.message ?? null : null;
  const retry = retryAction(connect, health);

  // The view changed under the focus (its button is gone): focus moves to the card's first action, else the card.
  const sectionRef = useRef<HTMLElement>(null);
  const focusInside = useRef(false);
  const prevView = useRef(view);
  useLayoutEffect(() => {
    const sec = sectionRef.current;
    if (sec && prevView.current !== view && focusInside.current) {
      const active = document.activeElement;
      if (!active || active === document.body || !document.contains(active)) {
        (sec.querySelector<HTMLElement>('.conn-foot button') ?? sec).focus({ preventScroll: true });
      }
    }
    prevView.current = view;
    focusInside.current = !!sec && sec.contains(document.activeElement);
  });
  // Another state (a new version, a sign-out) makes an earlier "Up to date" stale.
  useEffect(() => { setUpToDate(false); }, [view, health?.version]);

  const check = async () => {
    if (checking) return;
    setChecking(true);
    setUpToDate(false);
    try {
      const res = await checkConnection(store, id);
      const mine = res?.find((h) => h.provider === id);
      if (mine && !mine.updateAvailable) setUpToDate(true);
    } finally {
      setChecking(false);
    }
  };

  const forName = <>{' '}<span className="sr-only">for {name}</span></>;

  const checkedText = <small className="conn-checked">{health ? `Checked ${agoLabel(health.checkedAt, now)}` : ''}</small>;
  // aria-disabled, not disabled, while checking: focus stays on the button (check() ignores repeat presses).
  const checkNow = (
    <button className="btn ghost refresh" type="button" onClick={check} aria-disabled={checking || undefined} aria-busy={checking || undefined}>
      <Icon name="refresh" size="sm" className={checking ? 'spinning' : undefined} />Check now{' '}<span className="sr-only">for {name}</span>
    </button>
  );

  let body: ReactNode = null;
  let foot: ReactNode = null;
  switch (view) {
    case 'connected':
      body = (
        <>
          {health && (
            <dl className="facts">
              <dt>Version</dt>
              <dd>{health.version ?? 'Unknown'}{health.updateAvailable && health.latestVersion && <> · <span className="conn-update">{health.latestVersion} available</span></>}</dd>
              <dt>Latest</dt><dd>{health.latestVersion ?? 'Unknown'}</dd>
              <dt>Signed in</dt><dd>{signedInText(health.signedIn)}</dd>
              <dt>Chats found</dt><dd>{chats}</dd>
              <dt>Usage</dt><dd>{usage}</dd>
              {health.path && <><dt>Path</dt><dd className="mono" title={health.path}>{health.path}</dd></>}
            </dl>
          )}
          <div className="conn-toggles">
            <div className="toggle-row">
              <span>Show its chats in the sidebar</span>
              <Switch checked={intent.showChats ?? showChats ?? true} disabled={showChats === null} label={`Show ${name} chats in the sidebar`} onChange={(on) => void toggle('showChats', on)} />
            </div>
            <div className="toggle-row">
              <span>Suggest it for new chats</span>
              <Switch checked={intent.suggest ?? suggest ?? true} disabled={suggest === null} label={`Suggest ${name} for new chats`} onChange={(on) => void toggle('suggest', on)} />
            </div>
          </div>
          {NOTE[id] && <div className="conn-note"><Icon name="help" />{NOTE[id]}</div>}
        </>
      );
      foot = (
        <>
          {health?.updateAvailable && health.latestVersion
            ? <button className="btn" type="button" {...busyProps('update')}><Icon name="refresh" size="sm" />Update to {health.latestVersion}{forName}</button>
            : (
              <button className="btn ghost refresh" type="button" onClick={check} aria-disabled={checking || undefined} aria-busy={checking || undefined}>
                {checking ? <><StatusIcon state="running" />Checking…</> : upToDate ? <><Icon name="check" size="sm" />Up to date</> : <><Icon name="refresh" size="sm" />Check for updates</>}
                {' '}<span className="sr-only">for {name}</span>
              </button>
            )}
          {checkedText}
          <span className="grow" />
          <button className="btn ghost" type="button" ref={signOutRef} aria-haspopup="dialog" onClick={() => setConfirm((o) => !o)}>Sign out{' '}<span className="sr-only">of {name}</span></button>
        </>
      );
      break;
    case 'degraded':
      body = health && installed && (
        <dl className="facts">
          <dt>Version</dt><dd>{health.version ?? 'Unknown'}</dd>
          <dt>Signed in</dt><dd>{signedInText(health.signedIn)}</dd>
          <dt>Chats found</dt><dd>{chats}</dd>
          {health.path && <><dt>Path</dt><dd className="mono" title={health.path}>{health.path}</dd></>}
        </dl>
      );
      foot = <>{checkedText}<span className="grow" />{checkNow}</>;
      break;
    case 'missing':
      body = <span>{name} isn’t on this computer yet. Installing takes about a minute and uses the official {VENDOR[id]} installer.</span>;
      foot = <>{checkedText}<span className="grow" />{checkNow}<button className="btn primary" type="button" {...busyProps('install')}><span className="label">Install {name}</span></button></>;
      break;
    case 'signedout':
      body = (
        <>
          <span className="step-text"><span className="done-mark"><Icon name="check" /></span>Installed. Sign in to finish setting up.</span>
          <span>You’ll sign in on {SIGN_IN_ON[id]} in your browser, then come back here.</span>
        </>
      );
      foot = <>{checkedText}<span className="grow" />{checkNow}<button className="btn primary" type="button" {...busyProps('signin')}>Sign in{' '}<span className="sr-only">to {name}</span></button></>;
      break;
    case 'installing':
    case 'updating': {
      const step = connect?.step ?? (view === 'updating' ? `Updating ${name}…` : `Downloading ${name}…`);
      body = (
        <>
          <SwapText text={step} className="step-text" render={(t) => <><Icon name={t === 'Installed' ? 'check' : 'refresh'} size="sm" />{t}</>} />
          <Progress value={connect?.progress ?? null} step={step} label={view === 'updating' ? 'Update progress' : 'Install progress'} />
        </>
      );
      foot = <><span className="grow" /><button className="btn ghost" type="button" {...busyProps('cancel')}>Cancel{forName}</button></>;
      break;
    }
    case 'signin':
      body = antigravityStarting(id, connect) ? (
        <>
          <span className="step-text"><StatusIcon state="running" />{connect?.step ?? STARTING_ANTIGRAVITY}</span>
          {(connect?.step ?? STARTING_ANTIGRAVITY) === STARTING_ANTIGRAVITY && <span>{ANTIGRAVITY_SLOW}</span>}
        </>
      ) : (
        <>
          <span className="step-text"><StatusIcon state="running" />Finish signing in in your browser</span>
          <span>We opened {OPENED[id]}. This page updates on its own when you’re done.</span>
        </>
      );
      foot = (
        <>
          {connect?.signInUrl && <button className="link-btn" type="button" {...busyProps('open')}><Icon name="external" size="sm" />Open the browser again{forName}</button>}
          <span className="grow" />
          <button className="btn ghost" type="button" {...busyProps('cancel')}>Cancel{forName}</button>
        </>
      );
      break;
    case 'signingout':
      body = <span className="step-text"><StatusIcon state="running" />{connect?.step ?? 'Signing out…'}</span>;
      break;
    case 'error':
      if (!message) body = <span className="step-text conn-error" role="alert"><Icon name="x" size="sm" />Something went wrong. Try again.</span>;
      foot = <>{checkedText}<span className="grow" />{checkNow}<button className="btn primary" type="button" {...busyProps(retry)}>Try again{forName}</button></>;
      break;
    case 'unknown':
    case 'checking':
      foot = <>{checkedText}<span className="grow" />{checkNow}</>;
      break;
  }

  return (
    <section className="conn" data-conn={id} data-state={dot} aria-label={name} ref={sectionRef} tabIndex={-1} onFocus={() => { focusInside.current = true; }}>
      <div className="conn-head">
        <ProviderLogo id={id} />
        <div className="t"><h4 className="conn-name">{name}</h4><small>{VENDOR[id]}</small></div>
        <span className="conn-state" role="status"><i /><span>{word}</span></span>
      </div>
      <div className="conn-body">
        {message && (phase === 'error'
          ? <span className="step-text conn-error" role="alert"><Icon name="x" size="sm" />{message}</span>
          : <div className="conn-note conn-msg" role="status"><Icon name="help" />{message}</div>)}
        {body}
        {health?.message && <div className="conn-note"><Icon name="help" />{health.message}</div>}
        {id === 'antigravity' && <div className="conn-note"><Icon name="help" />{ANTIGRAVITY_SERVER}</div>}
      </div>
      <div className="conn-foot">{foot}</div>
      {view === 'connected' && (
        <Popover anchor={signOutRef.current} open={confirm} onClose={() => setConfirm(false)} align="right" label={`Sign out of ${name}?`} className="confirm" role="dialog">
          <b>Sign out of {name}?</b>
          <p>Agent Kanban stops starting {name} chats and reading its usage. Your chats stay in {name}, and running chats keep going there.</p>
          <div className="row">
            <button className="btn ghost" type="button" onClick={() => setConfirm(false)}>Cancel</button>
            <button className="btn danger" type="button" onClick={() => { setConfirm(false); void run('signout'); }}>Sign out</button>
          </div>
        </Popover>
      )}
    </section>
  );
}

const LATER = [
  { name: 'OpenCode', tile: 'O', badge: ['free', 'Free models'], text: 'Open-source agent that can run free and local models.' },
  { name: 'Qwen Code', tile: 'Q', badge: ['free', 'Free tier'], text: 'Free daily allowance with a Qwen account. Limits vary.' },
  { name: 'Cursor CLI', tile: 'C', badge: ['quiet', 'Your Cursor plan'], text: 'Cursor’s agent in the terminal, on your existing plan.' },
  { name: 'GitHub Copilot CLI', tile: 'G', badge: ['quiet', 'Your Copilot plan'], text: 'Copilot’s agent, on your existing GitHub plan.' },
] as const;

/** "Notify me" is remembered in this browser only; nothing is sent anywhere. */
const NOTIFY_KEY = 'agent-kanban.notify-me';
function readNotify(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(NOTIFY_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function saveNotify(names: string[]) {
  try { localStorage.setItem(NOTIFY_KEY, JSON.stringify(names)); } catch { /* storage blocked: kept for this page only */ }
}

function LaterCard({ item, on, onToggle }: { item: (typeof LATER)[number]; on: boolean; onToggle: () => void }) {
  // The label blurs over to its new text (design .btn .label.swapping); with reduced motion it changes at once.
  const [shownOn, setShownOn] = useState(on);
  const [swapping, setSwapping] = useState(false);
  useEffect(() => {
    if (on === shownOn) return;
    if (reducedMotion()) { setShownOn(on); return; }
    setSwapping(true);
    const t = setTimeout(() => { setShownOn(on); setSwapping(false); }, cssMs('--duration-swap', 200) / 2);
    return () => clearTimeout(t);
  }, [on]);
  return (
    <section className="conn later" aria-label={item.name}>
      <div className="conn-head">
        <span className="logo-tile" aria-hidden="true">{item.tile}</span>
        <div className="t"><h4 className="conn-name">{item.name}</h4><small><span className={`badge ${item.badge[0]}`}>{item.badge[1]}</span></small></div>
      </div>
      <div className="conn-body"><span>{item.text}</span></div>
      <div className="conn-foot">
        <span className="grow" />
        <button className={on ? 'btn' : 'btn ghost'} type="button" aria-pressed={on} onClick={onToggle}>
          <span className={swapping ? 'label swapping' : 'label'}>
            {shownOn ? <><Icon name="check" size="sm" />We’ll let you know</> : <><Icon name="bell" size="sm" />Notify me</>}
          </span>
          {' '}<span className="sr-only">about {item.name}</span>
        </button>
      </div>
    </section>
  );
}

function ComingLater() {
  const [notify, setNotify] = useState<string[]>(readNotify);
  const [request, setRequest] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const toggle = (n: string) => setNotify((cur) => {
    const next = cur.includes(n) ? cur.filter((x) => x !== n) : [...cur, n];
    saveNotify(next);
    return next;
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = request.trim();
    if (!v) { inputRef.current?.focus(); return; }
    toast(`Thanks. We’ve noted ${v}`);
    setRequest('');
  };
  return (
    <>
      <h3 className="section-title">More agents, coming later <span className="r later-note">Including free ones</span></h3>
      <div className="conn-grid">
        {LATER.map((l) => <LaterCard key={l.name} item={l} on={notify.includes(l.name)} onToggle={() => toggle(l.name)} />)}
        <form className="conn later" aria-label="Something else?" onSubmit={submit}>
          <div className="conn-head">
            <span className="logo-tile" aria-hidden="true"><Icon name="plus" /></span>
            <div className="t"><h4 className="conn-name">Something else?</h4><small>Tell us which agent you use</small></div>
          </div>
          <div className="conn-body">
            <label className="search later-input">
              <input ref={inputRef} name="agent-request" autoComplete="off" placeholder="For example: Amp, Goose, Aider…" aria-label="Agent name"
                value={request} onChange={(e) => setRequest(e.target.value)} />
            </label>
          </div>
          <div className="conn-foot"><span className="grow" /><button className="btn" type="submit">Request</button></div>
        </form>
      </div>
    </>
  );
}

/** Connections: one card per coding agent, with Install / Sign in / Sign out / Update run by the server's ConnectService. */
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
        <ComingLater />
      </div>
    </div>
  );
}
