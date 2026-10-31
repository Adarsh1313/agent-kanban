import { statSync } from 'node:fs';
import type { Chat, Effort, ProviderId, Routine, RoutineResult, RoutineSchedule, ServerEvent } from '@agent-kanban/shared';
import type { RoutineInput, Store, StoredRoutine } from './store.ts';

const PROVIDERS: ProviderId[] = ['claude', 'codex', 'antigravity'];
const EFFORTS: Effort[] = ['quick', 'normal', 'thorough'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** A run missed by more than this (the app was closed) is not caught up. */
export const CATCH_UP_MS = 12 * 60 * 60_000;
/** A run that starts more than this after its time is marked "Ran late". */
const LATE_MS = 60_000;

export class RoutineError extends Error {}
export class RoutineNotFoundError extends Error {
  constructor() { super('Routine not found.'); }
}

/** The time of day on `day` as a local Date. */
function at(day: Date, time: string): Date {
  const [h, m] = time.split(':').map(Number) as [number, number];
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0);
}

/** The latest scheduled time at or before `now`, within the past 8 days (null when none). */
export function lastDue(s: RoutineSchedule, now: Date): Date | null {
  for (let back = 0; back <= 7; back++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
    if (!s.days.includes(day.getDay())) continue;
    const t = at(day, s.time);
    if (t.getTime() <= now.getTime()) return t;
  }
  return null;
}

/** The first scheduled time after `now`. */
export function nextDue(s: RoutineSchedule, now: Date): Date | null {
  for (let ahead = 0; ahead <= 7; ahead++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ahead);
    if (!s.days.includes(day.getDay())) continue;
    const t = at(day, s.time);
    if (t.getTime() > now.getTime()) return t;
  }
  return null;
}

/** "Morning review · 31 Oct" */
export function runTitle(name: string, d: Date): string {
  return `${name} · ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

function folderExists(cwd: string): boolean {
  try { return statSync(cwd).isDirectory(); } catch { return false; }
}

function text(v: unknown, key: string, max: number): string {
  const t = typeof v === 'string' ? v.trim() : '';
  if (t === '' || t.length > max) throw new RoutineError(`"${key}" must be 1 to ${max} characters.`);
  return t;
}

function schedule(v: unknown): RoutineSchedule {
  const s = v as { days?: unknown; time?: unknown } | null;
  if (!s || typeof s !== 'object') throw new RoutineError('Schedule must have days and a time.');
  if (typeof s.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time)) throw new RoutineError('Time must be HH:MM, like 08:00.');
  if (!Array.isArray(s.days) || s.days.length === 0) throw new RoutineError('Pick at least one day.');
  if (!s.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) throw new RoutineError('Days must be 0 (Sunday) to 6 (Saturday).');
  return { days: [...new Set(s.days as number[])].sort((a, b) => a - b), time: s.time };
}

/** Checks a create (`partial` false) or patch body field by field; unknown fields are refused. */
export function parseRoutine(b: Record<string, unknown>, partial: boolean): Partial<RoutineInput> & { paused?: boolean } {
  const out: Partial<RoutineInput> & { paused?: boolean } = {};
  for (const [k, v] of Object.entries(b)) {
    if (k === 'name') out.name = text(v, 'name', 200);
    else if (k === 'cwd') {
      out.cwd = text(v, 'cwd', 4000);
      if (!folderExists(out.cwd)) throw new RoutineError("That folder doesn't exist.");
    } else if (k === 'provider') {
      if (!PROVIDERS.includes(v as ProviderId)) throw new RoutineError('Unknown provider. Use claude, codex or antigravity.');
      out.provider = v as ProviderId;
    } else if (k === 'effort') {
      if (!EFFORTS.includes(v as Effort)) throw new RoutineError('Effort must be quick, normal or thorough.');
      out.effort = v as Effort;
    } else if (k === 'kind') {
      if (v !== 'skill' && v !== 'prompt') throw new RoutineError('Kind must be skill or prompt.');
      out.kind = v;
    } else if (k === 'text') out.text = text(v, 'text', 20_000);
    else if (k === 'schedule') out.schedule = schedule(v);
    else if (k === 'chime' || k === 'paused') {
      if (typeof v !== 'boolean') throw new RoutineError(`"${k}" must be true or false.`);
      out[k] = v;
    } else throw new RoutineError(`You can't set "${k}".`);
  }
  if (!partial) {
    for (const k of ['name', 'cwd', 'provider', 'text', 'schedule'] as const) {
      if (out[k] === undefined) throw new RoutineError(`Missing "${k}".`);
    }
    out.effort ??= 'normal';
    out.kind ??= 'prompt';
    out.chime ??= false;
    if (out.paused) throw new RoutineError('A new routine starts unpaused.');
  }
  return out;
}

type Timer = unknown;

/** Routines and their scheduler: one timer for the next due run, only while the app is open (#45). */
export class RoutineService {
  private store: Store;
  private chats: { start(input: { provider: ProviderId; cwd: string; prompt: string; title: string; routineId: string }): Promise<Chat>; getChat(id: string): Chat };
  private broadcast: (e: ServerEvent) => void;
  private now: () => Date;
  private setTimer: (fn: () => void, ms: number) => Timer;
  private clearTimer: (t: Timer) => void;
  private timer: Timer | null = null;

  constructor(opts: {
    store: Store;
    chats: RoutineService['chats'];
    broadcast: (e: ServerEvent) => void;
    now?: () => Date;
    setTimer?: (fn: () => void, ms: number) => Timer;
    clearTimer?: (t: Timer) => void;
  }) {
    this.store = opts.store;
    this.chats = opts.chats;
    this.broadcast = opts.broadcast;
    this.now = opts.now ?? (() => new Date());
    this.setTimer = opts.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; });
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout));
  }

  private view(r: StoredRoutine): Routine {
    const { armedAt: _, ...rest } = r;
    const next = r.paused ? null : nextDue(r.schedule, this.now());
    return { ...rest, nextRunAt: next ? next.toISOString() : null };
  }

  list(): Routine[] { return this.store.listRoutines().map((r) => this.view(r)); }

  private mustGet(id: string): StoredRoutine {
    const r = this.store.getRoutine(id);
    if (!r) throw new RoutineNotFoundError();
    return r;
  }

  private changed(): void {
    this.broadcast({ type: 'routines.updated', routines: this.list() });
    this.arm();
  }

  create(body: Record<string, unknown>): Routine {
    const input = parseRoutine(body, false) as RoutineInput;
    const r = this.store.createRoutine(input, this.now().toISOString());
    this.changed();
    return this.view(r);
  }

  update(id: string, body: Record<string, unknown>): Routine {
    const before = this.mustGet(id);
    const patch: Partial<StoredRoutine> = parseRoutine(body, true);
    // Resuming starts afresh: a run due while paused is not caught up.
    if (before.paused && patch.paused === false) {
      patch.armedAt = this.now().toISOString();
      if (before.lastResult === 'folder_missing') patch.lastResult = null;
    }
    const r = this.store.updateRoutine(id, patch)!;
    this.changed();
    return this.view(r);
  }

  remove(id: string): void {
    if (!this.store.deleteRoutine(id)) throw new RoutineNotFoundError();
    this.changed();
  }

  /** "Run now": runs at once, whatever the schedule (still skipped while the last run is going). */
  async runNow(id: string): Promise<Routine> {
    await this.run(this.mustGet(id), this.now(), false);
    this.changed();
    return this.view(this.mustGet(id));
  }

  /** Runs every routine whose time has come and hasn't run yet: on start this catches up runs missed in the past 12 h. */
  async tick(): Promise<void> {
    const now = this.now();
    let ran = false;
    for (const r of this.store.listRoutines()) {
      if (r.paused) continue;
      const due = lastDue(r.schedule, now);
      if (!due || now.getTime() - due.getTime() > CATCH_UP_MS) continue;
      const since = Math.max(Date.parse(r.armedAt), r.lastRunAt ? Date.parse(r.lastRunAt) : 0);
      if (due.getTime() <= since) continue;
      await this.run(r, due, now.getTime() - due.getTime() > LATE_MS);
      ran = true;
    }
    if (ran) this.changed();
    else this.arm();
  }

  private async run(r: StoredRoutine, due: Date, late: boolean): Promise<void> {
    const now = this.now();
    // lastRunAt is the due time it answered, so the same due time never runs twice.
    const stamp = new Date(Math.max(due.getTime(), Date.parse(r.lastRunAt ?? '') || 0)).toISOString();
    const done = (lastResult: RoutineResult, extra: Partial<StoredRoutine> = {}) =>
      this.store.updateRoutine(r.id, { lastRunAt: stamp, lastResult, ...extra });
    if (!folderExists(r.cwd)) { done('folder_missing', { paused: true }); return; }
    if (r.lastChatId) {
      let last: Chat | undefined;
      try { last = this.chats.getChat(r.lastChatId); } catch { /* deleted */ }
      if (last?.column === 'running') { done('skipped_running'); return; }
    }
    // Effort (#42) and skills in their provider's form (#40) aren't built yet: the text is sent as a plain prompt.
    const chat = await this.chats.start({ provider: r.provider, cwd: r.cwd, prompt: r.text, title: runTitle(r.name, now), routineId: r.id });
    done(late ? 'ran_late' : 'ran', { lastChatId: chat.id });
  }

  /** Starts the scheduler: catches up, then keeps one timer for the next run. */
  start(): Promise<void> { return this.tick(); }

  stop(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  /** One timer for the next due run, never past the next midnight (re-armed then, as the local day changes). */
  private arm(): void {
    this.stop();
    const now = this.now();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
    let next = midnight;
    for (const r of this.store.listRoutines()) {
      if (r.paused) continue;
      const t = nextDue(r.schedule, now);
      if (t && t.getTime() < next) next = t.getTime();
    }
    this.timer = this.setTimer(() => { this.timer = null; void this.tick().catch((e) => console.error('Routine run failed:', e)); }, Math.max(0, next - now.getTime()));
  }
}
