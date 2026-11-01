import type { Routine, RoutineResult, RoutineSchedule } from '@agent-kanban/shared';

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** The day toggles start on Monday. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
export const WEEKDAYS = [1, 2, 3, 4, 5];

export type Repeat = 'daily' | 'weekdays' | 'days';

export function repeatOf(days: number[]): Repeat {
  const key = [...days].sort((a, b) => a - b).join(',');
  return key === ALL_DAYS.join(',') ? 'daily' : key === WEEKDAYS.join(',') ? 'weekdays' : 'days';
}

/** "08:00" -> "8:00 am" */
export function clockText(time: string): string {
  const [h, m] = time.split(':').map(Number) as [number, number];
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}

/** "Weekdays at 8:00 am", "Daily at 6:30 pm", "Mon, Wed at 9:00 am" */
export function scheduleText(s: RoutineSchedule): string {
  const repeat = repeatOf(s.days);
  const when = repeat === 'daily' ? 'Daily' : repeat === 'weekdays' ? 'Weekdays'
    : WEEK_ORDER.filter((d) => s.days.includes(d)).map((d) => DAY_SHORT[d]).join(', ');
  return `${when} at ${clockText(s.time)}`;
}

/** "Today 8:00 am", "Tomorrow 8:00 am", "Mon 8:00 am"; "Paused" when there is no next run. */
export function nextRunText(iso: string | null, now: number): string {
  if (!iso) return 'Paused';
  const d = new Date(iso);
  const time = clockText(`${d.getHours()}:${d.getMinutes()}`);
  const today = new Date(now);
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86_400_000);
  return `${days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : DAY_SHORT[d.getDay()]} ${time}`;
}

const RESULT_TEXT: Record<RoutineResult, string> = {
  ran: 'Ran', ran_late: 'Ran late', skipped_running: 'Skipped, still running', folder_missing: 'Folder missing',
};

export function resultText(r: Routine): string {
  return r.lastResult ? RESULT_TEXT[r.lastResult] : 'Not run yet';
}
