import { markAllNotificationsRead, markChatNotificationsRead, markNotificationRead, openChatIn, type AppNotification, type AppState } from '../../state/reducer.ts';
import { desktopBridge } from '../../desktop.ts';
import type { RequestAction } from '@agent-kanban/shared';
import type { Store } from '../../state/store.ts';
import { providerName } from '../primitives/ProviderLogo.tsx';
import { reducedMotion } from '../primitives/motion.ts';

/* ───────── Copy ───────── */

const NOTE_TEXT: Record<AppNotification['kind'], string> = {
  permission: 'wants to run a command',
  question: 'asked you a question',
  finished: 'finished. Ready for review',
  limit: 'is out of usage',
  error: 'stopped with an error',
};

/** The chat's title, or "A chat" while the chat is not loaded. */
export const notificationTitle = (s: AppState, n: AppNotification): string => s.chats[n.chatId]?.title || 'A chat';

/** What a permission asks for: "wants to edit a file", "wants to run a command" (also when unknown) or "wants to use a tool". */
export function permissionText(action: RequestAction | undefined): string {
  return action === 'edit' ? 'wants to edit a file' : action === 'tool' ? 'wants to use a tool' : NOTE_TEXT.permission;
}

/** "Claude Code wants to run a command" (the provider is "An agent" while the chat is not loaded). */
export function notificationText(s: AppState, n: AppNotification): string {
  const chat = s.chats[n.chatId];
  return `${chat ? providerName(chat.provider) : 'An agent'} ${n.kind === 'permission' ? permissionText(n.action) : NOTE_TEXT[n.kind]}`;
}

/** Opens the notification's chat in the side panel and marks it read (here and in other tabs). */
export function openNotification(store: Store, n: AppNotification): void {
  store.setState((s) => markNotificationRead(openChatIn(s, n.chatId), n.id));
  // An unreadable time must not relay a NaN cut-off (#19): fall back to now.
  const at = Date.parse(n.at);
  relay(store, { type: 'read', chatId: n.chatId, until: (Number.isFinite(at) ? at : Date.now()) + RELAY_SLACK_MS });
}

/** Marks every notification read (here and in other tabs). */
export function markAllRead(store: Store): void {
  // A notification with an unreadable time must not turn the relayed cut-off into NaN.
  const latest = Math.max(Date.now(), ...store.getState().notifications.map((n) => Date.parse(n.at)).filter(Number.isFinite));
  store.setState((s) => markAllNotificationsRead(s));
  relay(store, { type: 'all', until: latest + RELAY_SLACK_MS });
}

/* ───────── Read state across tabs (BroadcastChannel `agent-kanban.notify`) ───────── */

/**
 * Each tab numbers its notifications itself, so a read is relayed as chat id + arrival time, never by id;
 * the slack covers the few ms between two tabs receiving the same event. Messages carry ids and times only.
 */
type RelayMsg = { type: 'read'; chatId: string; until: number } | { type: 'all'; until: number };
const RELAY_SLACK_MS = 2000;
const CHANNEL = 'agent-kanban.notify';

function relay(store: Store, msg: RelayMsg): void {
  const cur = (globalThis as Holder)[REGISTRY];
  if (cur?.store === store) cur.post(msg);
}

function parseRelay(data: unknown): RelayMsg | null {
  if (!data || typeof data !== 'object') return null;
  const m = data as Record<string, unknown>;
  if (typeof m.until !== 'number' || !Number.isFinite(m.until)) return null;
  if (m.type === 'all') return { type: 'all', until: m.until };
  if (m.type === 'read' && typeof m.chatId === 'string') return { type: 'read', chatId: m.chatId, until: m.until };
  return null;
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

/**
 * The chime's volume: 200%, through one gain node. Each note peaks at 0.06, so even both notes at once peak at
 * 0.24 after it, far under full scale (1): louder, without clipping.
 */
const CHIME_VOLUME = 2;

/** Two sine notes, 880 Hz then 1320 Hz (1100 Hz, softer, for a finished chat). Failures are silent. */
export function chime(soft = false): void {
  const ctx = audioContext();
  if (!ctx) return;
  try {
    const t0 = ctx.currentTime;
    const volume = ctx.createGain();
    volume.gain.value = CHIME_VOLUME;
    volume.connect(ctx.destination);
    for (const [f, t] of [[880, 0], [soft ? 1100 : 1320, 0.09]] as const) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0, t0 + t);
      g.gain.linearRampToValueAtTime(0.06, t0 + t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + t + 0.35);
      o.connect(g).connect(volume);
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

function showDesktop(store: Store, s: AppState, n: AppNotification, shown: Map<string, Notification>): void {
  if (!getPrefs().desktop || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  // In the desktop app a window hidden to the tray still reports "visible": there, away means not focused.
  const desktop = desktopBridge();
  if (desktop ? document.hasFocus() : document.visibilityState !== 'hidden') return;
  try {
    const note = new Notification(notificationTitle(s, n), { body: notificationText(s, n), tag: n.chatId });
    // The same tag replaces the chat's previous notification: forget that one.
    for (const [id, other] of shown) if (other.tag === n.chatId) shown.delete(id);
    shown.set(n.id, note);
    note.onclose = () => {
      if (shown.get(n.id) === note) shown.delete(n.id);
    };
    note.onclick = () => {
      try {
        if (desktop) desktop.show();
        else window.focus();
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

interface Running { store: Store; stop: () => void; post: (msg: RelayMsg) => void }
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
  /** Desktop notifications still on screen, by notification id: closed once that item is read here. */
  const shown = new Map<string, Notification>();

  const closeRead = (s: AppState) => {
    if (shown.size === 0) return;
    const unread = new Set(s.notifications.filter((n) => n.unread).map((n) => n.id));
    for (const [id, note] of shown) {
      if (unread.has(id)) continue;
      shown.delete(id);
      try {
        note.close();
      } catch {
        // Already gone.
      }
    }
  };

  const unsubscribe = store.subscribe(() => {
    const s = store.getState();
    if (s.notifications === list) return;
    list = s.notifications;
    closeRead(s);
    const fresh = list.filter((n) => !seen.has(n.id));
    for (const n of list) seen.add(n.id);
    if (fresh.length === 0) return;
    // Newest first in the list; fire oldest first so the last desktop notification is the newest.
    for (const n of [...fresh].reverse()) if (n.unread) showDesktop(store, s, n, shown);
    const now = Date.now();
    if (now - lastRing < RING_GAP_MS) return;
    lastRing = now;
    const newest = fresh[0]!;
    if (getPrefs().sound) chime(newest.kind === 'finished');
    if (!reducedMotion()) for (const l of [...ringListeners]) l(newest.id);
  });

  // Reads made in another tab. A received message is applied here only, never posted on again.
  let channel: BroadcastChannel | null = null;
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(CHANNEL);
      channel.onmessage = (e: MessageEvent) => {
        const msg = parseRelay(e.data);
        if (!msg) return;
        store.setState((s) => (msg.type === 'all' ? markAllNotificationsRead(s, msg.until) : markChatNotificationsRead(s, msg.chatId, msg.until)));
      };
    }
  } catch {
    channel = null;
  }

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
    post: (msg) => {
      try {
        channel?.postMessage(msg);
      } catch {
        // The other tabs catch up on their own; nothing to do.
      }
    },
    stop: () => {
      unsubscribe();
      channel?.close();
      channel = null;
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
