import { useEffect, useState } from 'react';
import type { ProviderId, UsageReading } from '@agent-kanban/shared';
import { focusedProvider } from '../../state/selectors.ts';
import { useStore } from '../../state/store.ts';
import { ProviderLogo } from '../primitives/index.ts';
import { chipLabel, chipNote, chipPercent, levelOf, pct, shownProviders, windowOf } from './model.ts';
import { UsageFocus } from './UsageFocus.tsx';
import { UsagePopover } from './UsagePopover.tsx';

/** Two hairline meters: 5-hour on top, weekly below (only the windows the provider reports). */
export function MiniMeter({ reading }: { reading: UsageReading | undefined }) {
  const bar = (kind: 'five_hour' | 'weekly') => {
    const w = windowOf(reading, kind);
    // A window the provider doesn't report (e.g. no 5-hour limit) gets no bar rather than an empty one that reads as 0 %.
    return w ? <i data-level={levelOf(w.leftPct)} style={{ ['--left' as string]: Math.max(0, Math.min(100, w.leftPct)) / 100 }} /> : null;
  };
  return <span className="minimeter" aria-hidden="true">{bar('five_hour')}{bar('weekly')}</span>;
}

function Chip({ id, onOpen }: { id: ProviderId; onOpen: (id: ProviderId, el: HTMLElement) => void }) {
  const reading = useStore((s) => s.usage[id]);
  const note = chipNote(reading);
  const left = chipPercent(reading);
  const dim = reading?.status === 'signed_out' || reading?.status === 'unavailable' || reading?.status === 'error' || !reading;
  return (
    <button
      className="usage-chip"
      type="button"
      data-prov={id}
      data-dim={dim || undefined}
      aria-haspopup="dialog"
      aria-expanded="false"
      aria-label={chipLabel(id, reading)}
      onClick={(e) => onOpen(id, e.currentTarget)}
    >
      <ProviderLogo id={id} size="sm" />
      {left !== null && <MiniMeter reading={reading} />}
      <span className="pct">{note && left === null ? note : pct(left ?? 0)}</span>
    </button>
  );
}

/**
 * The top bar's usage: one chip per installed provider (logo, two hairline meters, the lower percent), each
 * opening the usage dropdown. When a provider is focused it shows that provider's limits instead (UsageFocus).
 */
export function UsageChips() {
  const ids = useStore(shownProviders);
  const focus = useStore(focusedProvider);
  const [anchor, setAnchor] = useState<{ id: ProviderId; el: HTMLElement } | null>(null);
  const [open, setOpen] = useState(false);

  const toggle = (id: ProviderId, el: HTMLElement) => {
    const same = anchor?.el === el && open;
    setAnchor({ id, el });
    setOpen(!same);
  };

  // The chip it hangs from went away (provider uninstalled) or the bar switched to one provider: close it.
  const gone = !!focus || (anchor !== null && !ids.includes(anchor.id));
  useEffect(() => {
    if (gone) {
      setOpen(false);
      setAnchor(null);
    }
  }, [gone]);

  if (focus) return <UsageFocus provider={focus} />;
  return (
    <>
      {ids.map((id) => <Chip key={id} id={id} onOpen={toggle} />)}
      {ids.length > 0 && <UsagePopover anchor={anchor?.el ?? null} open={open && !gone} onClose={() => setOpen(false)} providers={ids} label="Usage for all providers" />}
    </>
  );
}
