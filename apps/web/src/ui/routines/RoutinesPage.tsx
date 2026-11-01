import { useId, useState } from 'react';
import type { Effort, ProviderId, Routine } from '@agent-kanban/shared';
import { api, type RoutineBody } from '../../api/client.ts';
import { useStore } from '../../state/store.ts';
import { Dialog, Icon, PROVIDER_IDS, ProviderLogo, Switch, toast, providerName } from '../primitives/index.ts';
import { folderKey } from '../projects/model.ts';
import { ALL_DAYS, DAY_NAMES, WEEK_ORDER, WEEKDAYS, nextRunText, repeatOf, resultText, scheduleText, type Repeat } from './model.ts';

const EFFORTS: [Effort, string][] = [['quick', 'Quick'], ['normal', 'Normal'], ['thorough', 'Thorough']];
const ONLY_WHILE_OPEN = 'Routines run only while Agent Kanban is open. A run missed in the last 12 hours runs once when you open it.';

const fail = (e: unknown) => toast(e instanceof Error ? e.message : String(e));

let editorOpen: ((r: Routine | null, cwd?: string) => void) | null = null;
/** Opens the routine editor: a routine to change, or null for a new one (in `cwd` when given). */
export function openRoutineEditor(r: Routine | null, cwd?: string): void { editorOpen?.(r, cwd); }

function nameOf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** One routine: name, project, schedule in words, next run and last result, with Pause/Resume, Run now, Edit and Delete. */
function RoutineRow({ r, now, onDelete, showProject }: { r: Routine; now: number; onDelete: (r: Routine) => void; showProject: boolean }) {
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); } catch (e) { fail(e); } finally { setBusy(false); }
  };
  return (
    <li className="routine-row" data-paused={r.paused || undefined}>
      <div className="routine-main">
        <b>{r.name}</b>
        <span className="routine-meta">
          {showProject && <><Icon name="folder" size="sm" />{nameOf(r.cwd)} · </>}
          <ProviderLogo id={r.provider} size="sm" />{scheduleText(r.schedule)}
        </span>
      </div>
      <span className="routine-next"><span className="cap">Next</span>{nextRunText(r.nextRunAt, now)}</span>
      <span className="routine-last" data-result={r.lastResult ?? undefined}><span className="cap">Last</span>{resultText(r)}</span>
      <div className="routine-actions">
        <button className="btn ghost" type="button" disabled={busy} onClick={() => void act(() => api.patchRoutine(r.id, { paused: !r.paused }))}>
          <Icon name={r.paused ? 'play' : 'stop'} size="sm" />{r.paused ? 'Resume' : 'Pause'}
        </button>
        <button className="btn ghost" type="button" disabled={busy} aria-label={`Run ${r.name} now`}
          onClick={() => void act(async () => { await api.runRoutine(r.id); toast(`${r.name} started.`); })}>
          <Icon name="send" size="sm" />Run now
        </button>
        <button className="btn icon-only ghost" type="button" aria-label={`Edit ${r.name}`} onClick={() => openRoutineEditor(r)}><Icon name="edit" size="sm" /></button>
        <button className="btn icon-only ghost" type="button" aria-label={`Delete ${r.name}`} onClick={() => onDelete(r)}><Icon name="x" size="sm" /></button>
      </div>
    </li>
  );
}

/** The list of routines (all, or one project's), with the delete confirmation. */
export function RoutineList({ routines, showProject = true, label = 'Routines' }: { routines: Routine[]; showProject?: boolean; label?: string }) {
  const now = useStore((s) => s.now);
  const [deleting, setDeleting] = useState<Routine | null>(null);
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    try { await api.deleteRoutine(deleting.id); setDeleting(null); } catch (e) { fail(e); } finally { setBusy(false); }
  };
  return (
    <>
      <ul className="routine-rows" aria-label={label}>
        {routines.map((r) => <RoutineRow key={r.id} r={r} now={now} onDelete={setDeleting} showProject={showProject} />)}
      </ul>
      <Dialog open={deleting !== null} onClose={() => setDeleting(null)} title="Delete this routine?"
        footer={<>
          <span className="grow" />
          <button className="btn ghost" type="button" onClick={() => setDeleting(null)}>Cancel</button>
          <button className="btn danger" type="button" disabled={busy} onClick={() => void remove()}>Delete routine</button>
        </>}>
        <p>{deleting?.name} stops running. The chats it already made stay on your board.</p>
      </Dialog>
    </>
  );
}

interface Draft { name: string; cwd: string; provider: ProviderId; effort: Effort; text: string; repeat: Repeat; days: number[]; time: string; chime: boolean }

function draftOf(r: Routine | null, cwd: string, provider: ProviderId): Draft {
  if (!r) return { name: '', cwd, provider, effort: 'normal', text: '', repeat: 'weekdays', days: WEEKDAYS, time: '08:00', chime: false };
  return { name: r.name, cwd: r.cwd, provider: r.provider, effort: r.effort, text: r.text, repeat: repeatOf(r.schedule.days), days: r.schedule.days, time: r.schedule.time, chime: r.chime };
}

/** New routine / Edit routine: name, project, provider, effort, skill or prompt, schedule and chime. */
export function RoutineEditor() {
  const projects = useStore((s) => s.projects);
  const suggested = useStore((s) => s.suggested);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Routine | null>(null);
  const [d, setD] = useState<Draft>(() => draftOf(null, '', 'claude'));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  editorOpen = (r, cwd) => {
    setEditing(r);
    setD(draftOf(r, cwd ?? projects[0]?.path ?? '', suggested ?? 'claude'));
    setError(null);
    setOpen(true);
  };
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => { setD((x) => ({ ...x, [k]: v })); setError(null); };
  const days = d.repeat === 'daily' ? ALL_DAYS : d.repeat === 'weekdays' ? WEEKDAYS : d.days;
  const toggleDay = (day: number) => set('days', d.days.includes(day) ? d.days.filter((x) => x !== day) : [...d.days, day]);
  const folders = projects.some((p) => folderKey(p.path) === folderKey(d.cwd)) || !d.cwd ? projects.map((p) => p.path) : [d.cwd, ...projects.map((p) => p.path)];

  const save = async () => {
    if (!d.name.trim()) return setError('Give the routine a name.');
    if (!d.cwd) return setError('Pick a project.');
    if (!d.text.trim()) return setError('Write what the agent should do.');
    if (days.length === 0) return setError('Pick at least one day.');
    // A "/skill" line is stored as a skill; it is sent as a plain prompt until skills (#40) are built.
    const body: RoutineBody = {
      name: d.name.trim(), cwd: d.cwd, provider: d.provider, effort: d.effort, kind: d.text.trim().startsWith('/') ? 'skill' : 'prompt',
      text: d.text.trim(), schedule: { days: [...days].sort((a, b) => a - b), time: d.time }, chime: d.chime,
    };
    setBusy(true);
    try {
      if (editing) await api.patchRoutine(editing.id, body);
      else await api.createRoutine(body);
      setOpen(false);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onClose={() => setOpen(false)} title={editing ? 'Edit routine' : 'New routine'}
      footer={<>
        <span className={`grow dlg-hint${error ? ' warn' : ''}`} role={error ? 'alert' : undefined}>{error ?? ''}</span>
        <button className="btn ghost" type="button" onClick={() => setOpen(false)}>Cancel</button>
        <button className="btn primary" type="button" disabled={busy} onClick={() => void save()}>{editing ? 'Save' : 'Create routine'}</button>
      </>}>
      <div className="routine-form">
        <label className="field"><span>Name</span>
          <input type="text" name="routine-name" autoComplete="off" placeholder="Morning review" value={d.name} onChange={(e) => set('name', e.target.value)} />
        </label>
        <label className="field"><span>Project</span>
          <select name="routine-project" value={d.cwd} onChange={(e) => set('cwd', e.target.value)}>
            {!d.cwd && <option value="">Pick a project</option>}
            {folders.map((p) => <option key={p} value={p}>{nameOf(p)}</option>)}
          </select>
        </label>
        <label className="field"><span>Provider</span>
          <select name="routine-provider" value={d.provider} onChange={(e) => set('provider', e.target.value as ProviderId)}>
            {PROVIDER_IDS.map((p) => <option key={p} value={p}>{providerName(p)}</option>)}
          </select>
        </label>
        <label className="field"><span>Effort</span>
          <select name="routine-effort" value={d.effort} onChange={(e) => set('effort', e.target.value as Effort)}>
            {EFFORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label className="field wide"><span>Skill or prompt</span>
          <textarea name="routine-text" autoComplete="off" placeholder="Review yesterday’s changes and list anything left to do" value={d.text} onChange={(e) => set('text', e.target.value)} />
        </label>
        <fieldset className="field wide routine-repeat">
          <legend>Repeat</legend>
          <div className="seg" role="radiogroup" aria-label="Repeat">
            {([['daily', 'Daily'], ['weekdays', 'Weekdays'], ['days', 'Chosen days']] as const).map(([v, l]) => (
              <button key={v} type="button" role="radio" aria-checked={d.repeat === v} onClick={() => setD((x) => ({ ...x, repeat: v, days: v === 'days' ? days : x.days }))}>{l}</button>
            ))}
          </div>
          {d.repeat === 'days' && (
            <div className="routine-days" role="group" aria-label="Days">
              {WEEK_ORDER.map((day) => (
                <button key={day} type="button" aria-pressed={d.days.includes(day)} aria-label={DAY_NAMES[day]} onClick={() => toggleDay(day)}>{DAY_NAMES[day]!.slice(0, 2)}</button>
              ))}
            </div>
          )}
        </fieldset>
        <label className="field"><span>Time</span>
          <input type="time" name="routine-time" value={d.time} onChange={(e) => set('time', e.target.value)} />
        </label>
        <label className="field routine-chime">
          <Switch checked={d.chime} label="Chime when it finishes" onChange={(on) => set('chime', on)} />Chime when it finishes
        </label>
      </div>
      <p className="dlg-note" id={`${id}-note`}><Icon name="clock" size="sm" />{ONLY_WHILE_OPEN}</p>
    </Dialog>
  );
}

/** `#/routines`: every routine, and New routine. */
export function RoutinesPage() {
  const routines = useStore((s) => s.routines);
  const loaded = useStore((s) => s.loaded);
  return (
    <div className="view page routines-page">
      <div className="page-inner">
        <div className="page-head">
          <div className="t">
            <h2 className="page-title">Routines <span className="count">{routines.length}</span></h2>
            <p>{ONLY_WHILE_OPEN} Each run starts a new chat that ends in Review.</p>
          </div>
          <button className="btn primary" type="button" onClick={() => openRoutineEditor(null)}><Icon name="plus" size="sm" />New routine</button>
        </div>
        {!loaded ? null : routines.length === 0 ? (
          <div className="page-empty">
            <Icon name="clock" />
            <h3>No routines yet</h3>
            <p>Run a skill or prompt on a schedule, like a morning review on weekdays.</p>
            <button className="btn" type="button" onClick={() => openRoutineEditor(null)}>New routine</button>
          </div>
        ) : <RoutineList routines={routines} />}
      </div>
    </div>
  );
}
