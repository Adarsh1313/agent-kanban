import { useState } from 'react';
import type { ProviderId, UsageReading, UsageWindow } from '@agent-kanban/shared';
import { useStore, useStoreInstance } from '../../state/store.ts';
import { Icon, Popover, ProviderLogo, providerName } from '../primitives/index.ts';
import { chipNote, levelOf, modelWindows, pct, refreshUsage, resetText, updatedText, windowOf } from './model.ts';

/** One limit: name, "82% left", a fill that scales from the left (transform only), and when it resets. */
export function Meter({ name, w, now }: { name: string; w: UsageWindow; now: number }) {
  const reset = resetText(w, now);
  const left = Math.max(0, Math.min(100, w.leftPct));
  return (
    <div className="meter" data-level={levelOf(w.leftPct)}>
      <span className="name">{name}</span>
      <span className="val">{pct(w.leftPct)} left</span>
      <span className="track" role="meter" aria-label={`${name} left`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(left)} aria-valuetext={`${pct(w.leftPct)} left`}>
        <span className="fill" style={{ ['--left' as string]: left / 100 }} />
      </span>
      {reset && <span className="reset">{reset}</span>}
    </div>
  );
}

function ByModel({ windows, now }: { windows: UsageWindow[]; now: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="model-toggle" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="chevron-right" size="sm" />By model
      </button>
      <div className={`collapsible${open ? '' : ' closed'}`} inert={!open}>
        <div><div className="models">{windows.map((w) => <Meter key={w.label} name={w.label} w={w} now={now} />)}</div></div>
      </div>
    </>
  );
}

function ProviderBlock({ id, reading, installed, best, now }: { id: ProviderId; reading: UsageReading | undefined; installed: boolean; best: boolean; now: number }) {
  const five = windowOf(reading, 'five_hour');
  const week = windowOf(reading, 'weekly');
  const models = modelWindows(reading);
  const note = chipNote(reading, installed);
  const status = reading?.status;
  const badge = status === 'signed_out' ? 'Not signed in' : status === 'unavailable' ? 'Limits unavailable' : status === 'error' ? 'Last numbers' : null;
  return (
    <div className="prov-block" data-status={status ?? 'loading'} data-provider={id}>
      <div className="prov-head">
        <ProviderLogo id={id} />{providerName(id)}
        {best && !badge && <span className="state suggested">Most room</span>}
        {badge && <span className="state badge quiet">{badge}</span>}
      </div>
      {reading?.message && <div className="unavailable" role={status === 'error' ? 'status' : undefined}>{reading.message}</div>}
      {!reading?.message && note && status !== 'error' && <div className="unavailable">{note}</div>}
      {status !== 'signed_out' && status !== 'unavailable' && (
        <>
          {five && <Meter name="5-hour" w={five} now={now} />}
          {week && <Meter name="Weekly" w={week} now={now} />}
          {models.length > 0 && <ByModel windows={models} now={now} />}
        </>
      )}
    </div>
  );
}

export interface UsagePopoverProps {
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  providers: ProviderId[];
  label: string;
}

/** The usage dropdown: "Usage left", Refresh, then one block per provider (5-hour, weekly, By model). */
export function UsagePopover({ anchor, open, onClose, providers, label }: UsagePopoverProps) {
  const store = useStoreInstance();
  const readings = useStore((s) => providers.map((id) => s.usage[id]));
  const installed = useStore((s) => providers.map((id) => s.connections[id]?.installed === true));
  const suggested = useStore((s) => s.suggested);
  const now = useStore((s) => s.now);
  const [checking, setChecking] = useState(false);

  const refresh = async () => {
    if (checking) return;
    setChecking(true);
    try {
      await refreshUsage(store);
    } finally {
      setChecking(false);
    }
  };

  const updated = checking ? 'Checking…' : updatedText(readings, now) ?? '';
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} align="right" label={label} className="usage-pop">
      <div className="hd">
        <div><b>Usage left</b><br /><small aria-live="polite">{updated}</small></div>
        <button className="btn ghost refresh" type="button" onClick={refresh} disabled={checking} aria-busy={checking}>
          <Icon name="refresh" className={checking ? 'spinning' : undefined} />Refresh
        </button>
      </div>
      {providers.map((id, i) => <ProviderBlock key={id} id={id} reading={readings[i]} installed={installed[i]!} best={suggested === id} now={now} />)}
    </Popover>
  );
}
