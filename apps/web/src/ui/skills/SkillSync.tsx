import { useCallback, useEffect, useId, useState, type KeyboardEvent } from 'react';
import type { ProviderId, SkillsReport } from '@agent-kanban/shared';
import { api } from '../../api/client.ts';
import { applySettings } from '../../state/reducer.ts';
import { useStore, useStoreInstance } from '../../state/store.ts';
import { PROVIDER_IDS, ProviderLogo, providerName, Switch, toast } from '../primitives/index.ts';

/* Skill sync (#40): the home provider pick (onboarding and Connections), the synced list, Sync now. */

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** Names shown before "Show more". */
const FIRST = 6;

/** The last sync report, refetched when the home provider or the switch changes. */
export function useSkills(): { report: SkillsReport | null; setReport: (r: SkillsReport) => void } {
  const key = useStore((s) => `${s.settings?.homeProvider ?? ''}|${s.settings?.skillSync ?? ''}`);
  const [report, setReport] = useState<SkillsReport | null>(null);
  useEffect(() => {
    let live = true;
    api.skills().then((r) => { if (live) setReport(r); }, () => {});
    return () => { live = false; };
  }, [key]);
  return { report, setReport };
}

function useSaveSettings() {
  const store = useStoreInstance();
  return useCallback(async (patch: { homeProvider?: ProviderId; skillSync?: boolean }) => {
    try {
      const next = await api.patchSettings(patch);
      store.setState((s) => applySettings(s, next));
    } catch (e) { toast(errText(e)); }
  }, [store]);
}

/** One tile per provider; arrow keys move the choice (a radio group). */
export function HomeProviderPicker({ ids = PROVIDER_IDS }: { ids?: ProviderId[] }) {
  const home = useStore((s) => s.settings?.homeProvider ?? null);
  const save = useSaveSettings();
  const pick = (id: ProviderId) => { if (id !== home) void save({ homeProvider: id }); };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const i = Math.max(0, ids.indexOf(home ?? ids[0]!));
    const next = ids[(i + d + ids.length) % ids.length]!;
    pick(next);
    (e.currentTarget.querySelector(`[data-home="${next}"]`) as HTMLElement | null)?.focus();
  };
  return (
    <div className="conn-grid home-pick" role="radiogroup" aria-label="Home provider" onKeyDown={onKey}>
      {ids.map((id, i) => {
        const on = home === id;
        return (
          <button key={id} type="button" className="conn home-tile" role="radio" aria-checked={on} data-home={id}
            tabIndex={on || (!home && i === 0) ? 0 : -1} onClick={() => pick(id)}>
            <span className="conn-head"><ProviderLogo id={id} /><span className="conn-name">{providerName(id)}</span></span>
            <small>{on ? 'Your home provider' : 'Use as home'}</small>
          </button>
        );
      })}
    </div>
  );
}

/** Synced skill names (first few, the rest behind Show more) and the copies left out. */
export function SkillList({ report }: { report: SkillsReport | null }) {
  const [more, setMore] = useState(false);
  const listId = useId();
  if (!report) return null;
  const names = more ? report.synced : report.synced.slice(0, FIRST);
  return (
    <div className="skill-list">
      <p>{report.synced.length ? `${report.synced.length} skill${report.synced.length === 1 ? '' : 's'} synced` : 'No skills synced yet.'}</p>
      {report.synced.length > 0 && (
        <ul id={listId} aria-label="Synced skills">{names.map((n) => <li key={n}>{n}</li>)}</ul>
      )}
      {report.synced.length > FIRST && (
        <button className="link-btn" type="button" aria-expanded={more} aria-controls={listId} onClick={() => setMore((m) => !m)}>{more ? 'Show less' : 'Show more'}</button>
      )}
      {report.skipped.map((s) => <small key={`${s.provider}/${s.name}`} className="skill-skipped">Not synced: you already have {s.name} in {providerName(s.provider)}</small>)}
    </div>
  );
}

/** Connections → Skill sync: home provider, the one switch, Sync now and what was copied. */
export function SkillSyncSection() {
  const { homeProvider, skillSync } = useStore((s) => ({ homeProvider: s.settings?.homeProvider ?? null, skillSync: s.settings?.skillSync ?? false }));
  const save = useSaveSettings();
  const { report, setReport } = useSkills();
  const [busy, setBusy] = useState(false);
  const syncNow = async () => {
    setBusy(true);
    try { setReport(await api.syncSkills()); } catch (e) { toast(errText(e)); } finally { setBusy(false); }
  };
  return (
    <section className="skill-sync" aria-labelledby="skill-sync-h">
      <h3 className="section-title" id="skill-sync-h">Skill sync</h3>
      <p className="lead">Your home provider’s skills and global instructions are copied to the other agents, so they work the way you do.</p>
      <HomeProviderPicker />
      <div className="settings-list">
        <div className="toggle-row">
          <span>Skill sync<small>{homeProvider ? `Copies ${providerName(homeProvider)}’s skills to the others` : 'Pick a home provider first'}</small></span>
          <Switch checked={skillSync} label="Skill sync" disabled={!homeProvider} onChange={(on) => void save({ skillSync: on })} />
        </div>
      </div>
      {skillSync && <SkillList report={report} />}
      {skillSync && <button className="btn" type="button" aria-busy={busy || undefined} disabled={busy} onClick={() => void syncNow()}>Sync now</button>}
    </section>
  );
}
