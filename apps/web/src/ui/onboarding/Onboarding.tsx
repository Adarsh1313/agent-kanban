import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ProviderId } from '@agent-kanban/shared';
import { api } from '../../api/client.ts';
import { applySettings, type AppState } from '../../state/reducer.ts';
import { providerCounts } from '../../state/selectors.ts';
import { useStore, useStoreInstance, type Store } from '../../state/store.ts';
import { openNewChat } from '../actions.ts';
import { ANTIGRAVITY_SLOW, antigravityStarting, cardView, checkConnection, isConnected, retryAction, useConnectRun, useProviderToggle } from '../connections/ConnectionsPage.tsx';
import { BLOCKED, UNSUPPORTED } from '../notify/NotificationsPopover.tsx';
import { chime, desktopSupport, enableDesktop, getPrefs, primeAudio, setPrefs, subscribePrefs, type DesktopSupport } from '../notify/notifier.ts';
import { freeze, unfreeze } from '../primitives/Dialog.tsx';
import { pushLayer } from '../primitives/layers.ts';
import { cssMs, cssValue, reducedMotion } from '../primitives/motion.ts';
import { Icon, PROVIDER_IDS, ProviderLogo, providerName, StatusIcon, Switch, toast, type StatusState } from '../primitives/index.ts';
import { navigate } from '../shell/route.ts';

/* First-run onboarding (design/onboarding.js): Welcome → Connect → Bring in your chats → Notifications → Ready. */

const STEP_COUNT = 4;
const TABBABLE = 'input, textarea, select, button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'; // Welcome isn't counted
/** The most recent projects shown as chips; the rest are counted (a real computer can have dozens). */
const MAX_CHIPS = 12;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Settings menu → Replay onboarding: shows it again without telling the server (finishing writes onboarded: true). */
export function replayOnboarding(store: Store): void {
  store.setState((s) => (s.settings ? { ...s, settings: { ...s.settings, onboarded: false } } : s));
}

/** Writes onboarded: true. A failure toasts the server's text and resolves false. */
export async function finishOnboarding(store: Store): Promise<boolean> {
  try {
    const settings = await api.patchSettings({ onboarded: true });
    store.setState((s) => applySettings(s, settings));
    return true;
  } catch (e) {
    toast(errText(e));
    return false;
  }
}

const connectedIds = (s: AppState): ProviderId[] => PROVIDER_IDS.filter((id) => isConnected(s.connections[id]));

/* ───────── Step 0: Welcome, with a tiny board that shows the idea ───────── */

type MiniCol = 'running' | 'needs' | 'review' | 'done';
const MINI_COLS: [MiniCol, StatusState, string][] = [['running', 'running', 'Running'], ['needs', 'needs', 'Needs you'], ['review', 'review', 'Review'], ['done', 'done', 'Done']];
const MINI_ORDER: MiniCol[] = ['running', 'needs', 'running', 'review', 'done'];

function MiniBoard() {
  const [i, setI] = useState(0);
  const cardRef = useRef<HTMLDivElement>(null);
  const from = useRef<DOMRect | null>(null);
  const started = useRef(false);

  // Running → Needs you → Running → Review → Done, then round again. Nothing moves with reduced motion.
  useEffect(() => {
    if (reducedMotion()) return;
    const wait = !started.current ? 1200 : i === MINI_ORDER.length - 1 ? 2400 : 1500;
    started.current = true;
    const t = setTimeout(() => {
      from.current = cardRef.current?.getBoundingClientRect() ?? null;
      setI((n) => (n + 1) % MINI_ORDER.length);
    }, wait);
    return () => clearTimeout(t);
  }, [i]);

  // FLIP: the card renders in its new column, then travels there from where it was (lifted, --ease-in-out).
  useLayoutEffect(() => {
    const el = cardRef.current;
    const a = from.current;
    from.current = null;
    if (!el || !a || typeof el.animate !== 'function') return;
    const b = el.getBoundingClientRect();
    const dx = a.left - b.left;
    const dy = a.top - b.top;
    if (!dx && !dy) return;
    el.animate(
      [{ transform: `translate(${dx}px, ${dy}px) scale(${cssValue('--lift-scale', '1.02')})` }, { transform: 'translate(0, 0) scale(1)' }],
      { duration: cssMs('--duration-move', 260), easing: cssValue('--ease-in-out', 'ease-in-out') },
    );
  }, [i]);

  const at = MINI_ORDER[i]!;
  const moving = (
    <div className="mcard" ref={cardRef}>
      <b>Add a sign-up page</b>
      <div className="row">
        <ProviderLogo id="claude" size="sm" />
        {at === 'needs' ? <span className="badge needs">Question</span> : at === 'done' ? 'Done' : 'Sonnet'}
      </div>
      {at === 'running' && <div className="sweep" />}
    </div>
  );
  const fixed: Record<MiniCol, ReactNode> = {
    running: null,
    needs: <div className="mcard"><b>Fix newsletter links</b><div className="row"><ProviderLogo id="codex" size="sm" /><span className="badge needs">Permission</span></div></div>,
    review: <div className="mcard"><b>Sales summary</b><div className="row"><ProviderLogo id="antigravity" size="sm" />Gemini 3 Pro</div></div>,
    done: null,
  };
  return (
    <div className="mini" aria-hidden="true">
      {MINI_COLS.map(([col, icon, name]) => (
        <div className="mc" key={col} data-mc={col}>
          <div className="mh"><StatusIcon state={icon} />{name}</div>
          {at === col && moving}
          {fixed[col]}
        </div>
      ))}
    </div>
  );
}

/* ───────── Step 1: Connect ───────── */

function AgentRow({ id }: { id: ProviderId }) {
  const store = useStoreInstance();
  const { health, connect, loaded } = useStore((s) => ({ health: s.connections[id], connect: s.connect[id], loaded: s.loaded }));
  const { busyProps } = useConnectRun(id);
  const [checking, setChecking] = useState(false);
  const view = cardView(health, connect, loaded);
  const name = providerName(id);
  const phase = connect?.phase ?? 'idle';
  const message = phase === 'idle' || phase === 'error' ? connect?.message ?? null : null;
  const forName = <>{' '}<span className="sr-only">for {name}</span></>;

  // The row changed under the focus (its button is gone): focus moves to the row's first button, else the row.
  const rowRef = useRef<HTMLDivElement>(null);
  const focusInside = useRef(false);
  const prevView = useRef(view);
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (row && prevView.current !== view && focusInside.current) {
      const active = document.activeElement;
      if (!active || active === document.body || !document.contains(active)) (row.querySelector<HTMLElement>('button') ?? row).focus({ preventScroll: true });
    }
    prevView.current = view;
    focusInside.current = !!row && row.contains(document.activeElement);
  });

  const check = async () => {
    if (checking) return;
    setChecking(true);
    try { await checkConnection(store, id); } finally { setChecking(false); }
  };

  let sub: ReactNode;
  let act: ReactNode = null;
  switch (view) {
    case 'checking':
    case 'unknown':
      sub = <span className="skel" />;
      break;
    case 'connected':
      sub = <><Icon name="check" size="sm" />Found and signed in</>;
      act = <span className="ok"><span className="done-mark"><Icon name="check" /></span>Connected</span>;
      break;
    case 'signedout':
      sub = message ?? 'Installed, not signed in';
      act = <button className="btn" type="button" {...busyProps('signin')}>Sign in{' '}<span className="sr-only">to {name}</span></button>;
      break;
    case 'missing':
      sub = message ?? 'Not on this computer';
      act = <button className="btn" type="button" {...busyProps('install')}>Install{' '}<span className="sr-only">{name}</span></button>;
      break;
    case 'installing':
    case 'updating': {
      const step = connect?.step ?? (view === 'updating' ? `Updating ${name}…` : 'Installing…');
      const p = Math.max(0, Math.min(1, connect?.progress ?? 0));
      sub = step;
      act = (
        <>
          <div className="progress" role="progressbar" aria-label={view === 'updating' ? 'Update progress' : 'Install progress'} aria-valuetext={step}
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={connect?.progress == null ? undefined : Math.round(p * 100)}>
            <i style={{ '--p': p } as CSSProperties} />
          </div>
          <button className="btn ghost" type="button" {...busyProps('cancel')}>Cancel{forName}</button>
        </>
      );
      break;
    }
    case 'signin':
      sub = <><StatusIcon state="running" />{antigravityStarting(id, connect) ? connect?.step ?? 'Starting Antigravity…' : 'Finish signing in in your browser'}</>;
      act = (
        <>
          {connect?.signInUrl && <button className="link-btn" type="button" {...busyProps('open')}><Icon name="external" size="sm" />Open the browser again{forName}</button>}
          <button className="btn ghost" type="button" {...busyProps('cancel')}>Cancel{forName}</button>
        </>
      );
      break;
    case 'signingout':
      sub = <><StatusIcon state="running" />{connect?.step ?? 'Signing out…'}</>;
      break;
    case 'degraded':
      sub = health?.message ?? 'Needs attention';
      act = <button className="btn ghost" type="button" onClick={check} aria-disabled={checking || undefined} aria-busy={checking || undefined}>Check now{forName}</button>;
      break;
    case 'error':
      sub = <span role="alert">{message ?? 'Something went wrong. Try again.'}</span>;
      act = <button className="btn" type="button" {...busyProps(retryAction(connect, health))}>Try again{forName}</button>;
      break;
  }
  const slow = id === 'antigravity' && (view === 'installing' || (view === 'signin' && antigravityStarting(id, connect)));

  return (
    <div className="agent" data-agent={id} data-view={view} ref={rowRef} tabIndex={-1} onFocus={() => { focusInside.current = true; }}>
      <ProviderLogo id={id} />
      <div className="t">
        <b>{name}</b>
        <small>{sub}</small>
        {slow && <small>{ANTIGRAVITY_SLOW}</small>}
      </div>
      {act}
    </div>
  );
}

/* ───────── Step 2: chats found ───────── */

/**
 * Counts up quickly to `to` with an ease-out, from 0 at first and from the number shown when `to` changes later
 * (a refetch); at once with reduced motion. `to` null shows "—" (not known).
 */
function CountUp({ to }: { to: number | null }) {
  const [n, setN] = useState(() => (to === null || reducedMotion() || typeof requestAnimationFrame !== 'function' ? to ?? 0 : 0));
  const shown = useRef(n);
  shown.current = n;
  useEffect(() => {
    if (to === null) return;
    if (reducedMotion() || typeof requestAnimationFrame !== 'function') { setN(to); return; }
    const from = shown.current;
    if (from === to) return;
    const dur = 700;
    let t0: number | null = null;
    let raf = 0;
    const tick = (t: number) => {
      t0 ??= t; // the frame clock, not performance.now(): some environments time frames differently
      const k = Math.max(0, Math.min(1, (t - t0) / dur));
      setN(Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const done = setTimeout(() => setN(to), dur + 100); // in case the window is hidden
    return () => { cancelAnimationFrame(raf); clearTimeout(done); };
  }, [to]);
  return <span className="n">{to === null ? '—' : n}</span>;
}

/* ───────── Notifications ───────── */

const useNotifyPrefs = () => useSyncExternalStore(subscribePrefs, getPrefs, getPrefs);
/** The Ready step's notifications line: what will actually reach the user, desktop notifications only when the browser allows them. */
export function notificationsLine(p: { desktop: boolean; sound: boolean }, support: DesktopSupport): string {
  const desktop = p.desktop && support === 'granted';
  if (desktop) return `Notifications on${p.sound ? ', with sound' : ''}`;
  if (!p.sound) return 'Notifications off. Turn them on from the bell any time';
  if (support === 'denied') return 'Sound on; desktop notifications are blocked in your browser';
  if (support === 'unsupported') return 'Sound on; this browser can’t show desktop notifications';
  return 'Sound on; desktop notifications off';
}

/* ───────── The flow ───────── */

type Phase = 'hidden' | 'open' | 'closing';

/**
 * Full-screen first-run setup, shown once the first snapshot has loaded and settings say not onboarded (or after
 * Replay onboarding). The board behind is inert; Escape does nothing (the design has no skip).
 */
export function Onboarding() {
  const store = useStoreInstance();
  const want = useStore((s) => s.loaded && s.settings?.onboarded === false);
  const ids = useStore(connectedIds);
  const showChats = useStore((s) => s.settings?.showChats ?? null);
  const live = useStore(providerCounts);
  const projects = useStore((s) => s.projects);
  const prefs = useNotifyPrefs();
  const [support, setSupport] = useState<DesktopSupport>(desktopSupport);
  const [phase, setPhase] = useState<Phase>('hidden');
  const [step, setStep] = useState(0);
  const [back, setBack] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const thenRef = useRef<(() => void) | null>(null);
  const headingId = useId();
  const deskNote = useId();
  const toggles = { claude: useProviderToggle('claude'), codex: useProviderToggle('codex'), antigravity: useProviderToggle('antigravity') };
  const stepId = useId();

  // Once open, it stays open until finished (a resync that still says onboarded: true does not cut a replay short).
  // A layout effect: the re-render with the layer happens before the first paint, so the board never flashes.
  useLayoutEffect(() => {
    if (want && phase === 'hidden') {
      setStep(0);
      setBack(false);
      setPhase('open');
    }
  }, [want, phase]);

  const open = phase === 'open';
  // The shell behind is inert and keyboard shortcuts stay off; Escape closes nothing.
  useEffect(() => {
    const el = ref.current;
    if (!open || !el) return;
    const frozen = freeze((n) => n !== el && !n.matches('.popover, .tip, .toasts, script'));
    const release = pushLayer('dialog', () => {});
    return () => {
      unfreeze(frozen);
      release();
    };
  }, [open]);

  // After the freeze is released: run what Finish asked for (open New chat, go to the board), then fade out.
  useEffect(() => {
    if (phase !== 'closing') return;
    const then = thenRef.current;
    thenRef.current = null;
    then?.();
    const t = setTimeout(() => setPhase('hidden'), cssMs('--duration-exit', 160));
    return () => clearTimeout(t);
  }, [phase]);

  // Each step: focus its primary button (the heading while the primary is disabled).
  useLayoutEffect(() => {
    if (!open) return;
    const stage = ref.current?.querySelector('.onb-stage');
    const target = stage?.querySelector<HTMLElement>('[data-primary]:not(:disabled)') ?? stage?.querySelector<HTMLElement>('h1');
    target?.focus({ preventScroll: true });
  }, [open, step]);

  // Chat counts per provider. A switched-off provider keeps showing the number it had (the server then hides its history).
  const seen = useRef<Partial<Record<ProviderId, number>>>({});
  const count = (id: ProviderId) => {
    if (showChats?.[id] !== false) {
      seen.current[id] = live[id];
      return live[id];
    }
    // Hidden: the server leaves its history out, so only a count seen while it was shown is right; else "—".
    return seen.current[id] ?? null;
  };

  if (phase === 'hidden') return null;

  const go = (to: number) => {
    setBack(to < step);
    setStep(to);
  };
  const finish = async (then?: () => void) => {
    if (finishing) return;
    setFinishing(true);
    try {
      if (await finishOnboarding(store)) {
        thenRef.current = then ?? null;
        setPhase('closing');
      }
    } finally {
      setFinishing(false);
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Tab') {
      // Focus cycles within the layer (as Dialog does).
      const items = [...(ref.current?.querySelectorAll<HTMLElement>(TABBABLE) ?? [])];
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !ref.current?.contains(active))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (active === last || !ref.current?.contains(active))) { e.preventDefault(); first.focus(); }
      return;
    }
    if (e.key !== 'Enter' || e.target instanceof HTMLButtonElement) return;
    ref.current?.querySelector<HTMLButtonElement>('.onb-stage [data-primary]:not(:disabled)')?.click();
  };

  const backBtn = <button className="btn ghost" type="button" onClick={() => go(step - 1)}>Back</button>;
  const next = (disabled = false) => <button className="btn primary" type="button" data-primary disabled={disabled} onClick={() => go(step + 1)}>Continue</button>;
  const h1 = (children: ReactNode) => <h1 id={headingId} tabIndex={-1}>{children}</h1>;
  const shownProjects = projects.filter((p) => p.providers.some((x) => ids.includes(x.provider)));

  let pane: ReactNode;
  switch (step) {
    case 0:
      pane = (
        <>
          {h1(<>All your coding agents<br />on one board</>)}
          <p className="lead">Start chats with Claude Code, Codex and Antigravity, watch them work, and always know how much of each plan you have left.</p>
          <MiniBoard />
          <div className="onb-foot">
            <span className="grow">Takes about a minute. Nothing in your agent apps changes.</span>
            <button className="btn primary" type="button" data-primary onClick={() => go(1)}>Get started</button>
          </div>
        </>
      );
      break;
    case 1: {
      const n = ids.length;
      pane = (
        <>
          {h1('Connect the agents you use')}
          <p className="lead">We looked on this computer. Your sign-in stays inside each app; Agent Kanban never sees passwords or tokens.</p>
          <div className="agent-list">{PROVIDER_IDS.map((id) => <AgentRow key={id} id={id} />)}</div>
          <div className="onb-foot">
            {backBtn}
            <span className="grow" role="status">{n ? `${n} connected. You can add more later in Connections.` : 'Connect at least one to continue.'}</span>
            {next(n === 0)}
          </div>
        </>
      );
      break;
    }
    case 2:
      pane = (
        <>
          {h1('Bring in your chats')}
          <p className="lead">These are the chats already in your agent apps. They show up in the sidebar, grouped by project, with the same titles.</p>
          <div className="found">
            {ids.map((id) => (
              <div className="f" key={id} data-found={id}>
                <span className="h"><ProviderLogo id={id} size="sm" />{providerName(id)}</span>
                <CountUp to={count(id)} />
                <span className="h">chats</span>
                <div className="toggle-row onb-show">
                  <span>Show in sidebar</span>
                  <Switch checked={toggles[id].intent.showChats ?? showChats?.[id] !== false} label={`Show ${providerName(id)} chats in the sidebar`} onChange={(on) => void toggles[id].toggle('showChats', on)} />
                </div>
              </div>
            ))}
          </div>
          <div>
            <div className="k onb-k">FOUND IN {shownProjects.length} PROJECTS</div>
            <div className="proj-chips">
              {shownProjects.slice(0, MAX_CHIPS).map((p, i) => (
                <span key={p.id} style={{ animationDelay: `${400 + i * 40}ms` }} title={p.path}>
                  {p.providers.filter((x) => ids.includes(x.provider)).map((x) => <ProviderLogo key={x.provider} id={x.provider} size="sm" />)}
                  {p.name || p.path}
                </span>
              ))}
              {shownProjects.length > MAX_CHIPS && <span style={{ animationDelay: `${400 + MAX_CHIPS * 40}ms` }}>+{shownProjects.length - MAX_CHIPS} more</span>}
            </div>
          </div>
          <div className="reassure"><Icon name="eye" /><span>We only read chat titles and project folders. Nothing changes in your agent apps, and opening a chat here continues the same chat there.</span></div>
          <div className="onb-foot">{backBtn}<span className="grow" />{next()}</div>
        </>
      );
      break;
    case 3: {
      const deskOn = prefs.desktop && support === 'granted';
      const reason = support === 'unsupported' ? UNSUPPORTED : support === 'denied' ? BLOCKED : null;
      const changeDesktop = async (on: boolean) => {
        if (!on) { setPrefs({ desktop: false }); return; }
        setSupport(await enableDesktop());
      };
      pane = (
        <>
          {h1('Know when an agent needs you')}
          <p className="lead">Agents stop to ask permission or a question. We’ll tell you, so you don’t have to keep checking the board.</p>
          <div className="sample-note"><ProviderLogo id="codex" /><div><b>Wispr flow local setup</b><small>Codex wants to run a command</small></div></div>
          <div className="settings-list">
            <div className="toggle-row">
              <span>Desktop notifications<small>Shows even when Agent Kanban is in the background</small>{reason && <small id={deskNote}>{reason}</small>}</span>
              <Switch checked={deskOn} label="Desktop notifications" disabled={support === 'unsupported'} describedBy={reason ? deskNote : undefined} onChange={(v) => void changeDesktop(v)} />
            </div>
            <div className="toggle-row">
              <span>Sound<small>A soft chime. <button className="link-btn onb-play" type="button" onClick={() => { primeAudio(); chime(false); }}>Play it</button></small></span>
              <Switch checked={prefs.sound} label="Sound" onChange={(v) => {
                setPrefs({ sound: v });
                // The switch is a gesture: create the audio context now and play a preview.
                if (v) { primeAudio(); chime(true); }
              }} />
            </div>
          </div>
          <div className="onb-foot">{backBtn}<span className="grow">Windows will ask to allow notifications.</span>{next()}</div>
        </>
      );
      break;
    }
    default: {
      const chatsN = ids.reduce((n, id) => n + (showChats?.[id] !== false ? live[id] : 0), 0);
      const lines = [
        `${ids.length} agent${ids.length === 1 ? '' : 's'} connected: ${ids.map(providerName).join(', ')}`,
        `${chatsN} chats from ${shownProjects.length} projects in the sidebar`,
        notificationsLine(prefs, support),
      ];
      pane = (
        <>
          <div className="ready-mark"><Icon name="check" /></div>
          {h1('You’re set up')}
          <div className="summary">{lines.map((l, i) => <div key={i} style={{ animationDelay: `${200 + i * 60}ms` }}><Icon name="check" size="sm" />{l}</div>)}</div>
          <p className="lead">Start your first chat: pick a project, and we’ll suggest the agent with the most room left.</p>
          <div className="onb-foot">
            <button className="btn ghost" type="button" aria-disabled={finishing || undefined} onClick={() => void finish(() => {
              navigate('board');
              document.getElementById('main')?.focus({ preventScroll: true });
            })}>Go to the board</button>
            <span className="grow" />
            <button className="btn primary" type="button" data-primary aria-disabled={finishing || undefined} aria-busy={finishing || undefined}
              onClick={() => void finish(() => {
                // Focus waits on the board, so closing New chat returns it there rather than to the page body.
                document.getElementById('main')?.focus({ preventScroll: true });
                openNewChat();
              })}>
              <Icon name="plus" size="sm" />Start your first chat
            </button>
          </div>
        </>
      );
    }
  }

  return createPortal(
    <div className="onb" id="onb" ref={ref} role="dialog" aria-modal="true" aria-label="Set up Agent Kanban" data-state={open ? 'open' : 'closed'} onKeyDown={onKeyDown}>
      <div className="onb-top">
        <div className="brand">
          <span className="mark"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="3" y="4" width="5" height="16" rx="1.5" /><rect x="10" y="4" width="5" height="11" rx="1.5" /><rect x="17" y="4" width="4" height="7" rx="1.5" /></svg></span>
          Agent Kanban
        </div>
        <div className="onb-steps" aria-hidden={step === 0}>
          <small id={stepId}>{step ? `Step ${step} of ${STEP_COUNT}` : ''}</small>
          <div className="onb-bar">{Array.from({ length: STEP_COUNT }, (_, n) => <i key={n} style={{ '--f': n < step ? 1 : 0 } as CSSProperties} />)}</div>
        </div>
      </div>
      <div className="onb-stage">
        <div className={back ? 'onb-pane back' : 'onb-pane'} key={step} aria-labelledby={headingId} aria-describedby={step ? stepId : undefined} role="group">{pane}</div>
      </div>
    </div>,
    document.body,
  );
}
