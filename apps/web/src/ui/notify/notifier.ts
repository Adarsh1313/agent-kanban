import { markNotificationRead, openChatIn, type AppNotification, type AppState } from '../../state/reducer.ts';
import type { Store } from '../../state/store.ts';
import { providerName } from '../primitives/ProviderLogo.tsx';
import { reducedMotion } from '../primitives/motion.ts';

/* ───────── Copy ───────── */

const NOTE_TEXT: Record<AppNotification['kind'], string> = {
  permission: 'wants to run a command',
  question: 'asked you a question',
  finished: 'finished. Ready for review',
  limit: 'hit its usage limit',
  error: 'stopped with an error',
};

/** The chat's title, or "A chat" while the chat is not loaded. */
export const notificationTitle = (s: AppState, n: AppNotification): string => s.chats[n.chatId]?.title || 'A chat';

/** "Claude Code wants to run a command" (the provider is "An agent" while the chat is not loaded). */
export function notificationText(s: AppState, n: AppNotification): string {
  const chat = s.chats[n.chatId];
  return `${chat ? providerName(chat.provider) : 'An agent'} ${NOTE_TEXT[n.kind]}`;
}

/** Opens the notification's chat in the side panel and marks it read. */
export function openNotification(store: Store, n: AppNotification): void {
  store.setState((s) => markNotificationRead(openChatIn(s, n.chatId), n.id));
}

/* ───────── Prefs (localStorage `agent-kanban.notify`) ───────── */

export interface NotifyPrefs { desktop: boolean; sound: boolean }

const PREFS_KEY = 'agent-kanban.notify';
const DEFAULT_PREFS: NotifyPrefs = { desktop: false, sound: true };
let prefs: NotifyPrefs | null = null;
const prefListeners = new Set<() => void>();

function readPrefs(): NotifyPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    const v = raw ? (JSON.parse(raw) as Partial<NotifyPrefs>) : {};
    return {
      desktop: typeof v.desktop === 'boolean' ? v.desktop : DEFAULT_PREFS.desktop,
      sound: typeof v.sound === 'boolean' ? v.sound : DEFAULT_PREFS.sound,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function getPrefs(): NotifyPrefs {
  prefs ??= readPrefs();
  return prefs;
}

export function setPrefs(patch: Partial<NotifyPrefs>): void {
  prefs = { ...getPrefs(), ...patch };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Storage blocked: the choice still holds for this page.
  }
  for (const l of [...prefListeners]) l();
}

export function subscribePrefs(fn: () => void): () => void {
  prefListeners.add(fn);
  return () => {
    prefListeners.delete(fn);
  };
}

/** Forgets the cached prefs so the next read goes to localStorage again (tests). */
export function reloadPrefs(): void {
  prefs = null;
  for (const l of [...prefListeners]) l();
}

/* ───────── Desktop permission ───────── */

export type DesktopSupport = 'unsupported' | NotificationPermission;

export function desktopSupport(): DesktopSupport {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

/**
 * Turns desktop notifications on, asking the browser first when it has not been asked. Resolves to the
 * permission that decided it; the pref is only set when it is granted.
 */
export async function enableDesktop(): Promise<DesktopSupport> {
  if (typeof Notification === 'undefined') return 'unsupported';
  let perm = Notification.permission;
  if (perm === 'default') {
    try {
      perm = await Notification.requestPermission();
    } catch {
      perm = Notification.permission;
    }
  }
  if (perm === 'granted') setPrefs({ desktop: true });
  return perm;
}

/* ───────── Sound: the design's soft two-note chime, generated with WebAudio ───────── */

type AudioCtor = typeof AudioContext;
let audio: AudioContext | null = null;

/** The one shared AudioContext, created on first use and resumed if the browser suspended it. */
function audioContext(): AudioContext | null {
  try {
    if (!audio) {
      const Ctor = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext) as AudioCtor | undefined;
      if (!Ctor) return null;
      audio = new Ctor();
    }
    if (audio.state === 'suspended') void audio.resume().catch(() => {});
    return audio;
  } catch {
    return null;
  }
}

/** Creates (or resumes) the audio context inside a user gesture so later chimes are allowed to play. */
export const primeAudio = (): void => {
  audioContext();
};

/** Two sine notes, 880 Hz then 1320 Hz (1100 Hz, softer, for a finished chat). Failures are silent. */
export function chime(soft = false): void {
  const ctx = audioContext();
  if (!ctx) return;
  try {
    const t0 = ctx.currentTime;
    for (const [f, t] of [[880, 0], [soft ? 1100 : 1320, 0.09]] as const) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0, t0 + t);
      g.gain.linearRampToValueAtTime(0.06, t0 + t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + t + 0.35);
      o.connect(g).connect(ctx.destination);
      o.start(t0 + t);
      o.stop(t0 + t + 0.4);
    }
  } catch {
    // No sound is fine.
  }
}

/* ───────── Ring: the Bell listens ───────── */

// Kept on globalThis so a hot-reloaded Bell and the notifier started by main.tsx share one set.
const RING_KEY = Symbol.for('agent-kanban.ring');
const ringListeners: Set<(id: string) => void> = ((globalThis as { [RING_KEY]?: Set<(id: string) => void> })[RING_KEY] ??= new Set());

export function onRing(fn: (id: string) => void): () => void {
  ringListeners.add(fn);
  return () => {
    ringListeners.delete(fn);
  };
}

/** A burst rings (and chimes) once: at most one per this many ms. */
export const RING_GAP_MS = 600;

/* ───────── The notifier ───────── */

function showDesktop(store: Store, s: AppState, n: AppNotification): void {
  if (!getPrefs().desktop || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  if (document.visibilityState !== 'hidden') return;
  try {
    const note = new Notification(notificationTitle(s, n), { body: notificationText(s, n), tag: n.chatId });
    note.onclick = () => {
      try {
        window.focus();
      } catch {
        // Focus is best effort.
      }
      openNotification(store, n);
      note.close();
    };
  } catch {
    // Some browsers only allow notifications from a service worker; the bell still has it.
  }
}

interface Running { store: Store; stop: () => void }
const REGISTRY = Symbol.for('agent-kanban.notifier');
type Holder = { [REGISTRY]?: Running };

/**
 * Watches the store for new notifications: rings the bell, chimes when Sound is on, and shows a desktop
 * notification when Desktop is on and the tab is hidden. Notifications already in the store when it starts
 * never fire. Starting again for the same store is a no-op (StrictMode, HMR); returns a stop function.
 */
export function startNotifier(store: Store): () => void {
  const holder = globalThis as Holder;
  const cur = holder[REGISTRY];
  if (cur?.store === store) return cur.stop;
  cur?.stop();

  const seen = new Set(store.getState().notifications.map((n) => n.id));
  let list = store.getState().notifications;
  let lastRing = -Infinity;

  const unsubscribe = store.subscribe(() => {
    const s = store.getState();
    if (s.notifications === list) return;
    list = s.notifications;
    const fresh = list.filter((n) => !seen.has(n.id));
    for (const n of list) seen.add(n.id);
    if (fresh.length === 0) return;
    // Newest first in the list; fire oldest first so the last desktop notification is the newest.
    for (const n of [...fresh].reverse()) if (n.unread) showDesktop(store, s, n);
    const now = Date.now();
    if (now - lastRing < RING_GAP_MS) return;
    lastRing = now;
    const newest = fresh[0]!;
    if (getPrefs().sound) chime(newest.kind === 'finished');
    if (!reducedMotion()) for (const l of [...ringListeners]) l(newest.id);
  });

  // Browsers only let audio start inside a gesture: the first click or key press primes the context.
  const prime = () => {
    if (getPrefs().sound) primeAudio();
    document.removeEventListener('pointerdown', prime, true);
    document.removeEventListener('keydown', prime, true);
  };
  document.addEventListener('pointerdown', prime, true);
  document.addEventListener('keydown', prime, true);

  const running: Running = {
    store,
    stop: () => {
      unsubscribe();
      document.removeEventListener('pointerdown', prime, true);
      document.removeEventListener('keydown', prime, true);
      if (holder[REGISTRY] === running) delete holder[REGISTRY];
    },
  };
  holder[REGISTRY] = running;
  return running.stop;
}

/** Drops the shared audio context (tests). */
export function resetAudioForTests(): void {
  audio = null;
}
