import { useState } from 'react';
import type { ProviderId, UsageWindow } from '@agent-kanban/shared';
import { useStore, useStoreInstance } from '../../state/store.ts';
import { Icon, ProviderLogo, providerName } from '../primitives/index.ts';
import { chipLabel, chipNote, levelOf, pct, resetText, windowOf } from './model.ts';
import { UsagePopover } from './UsagePopover.tsx';

function FocusMeter({ name, w, now }: { name: string; w: UsageWindow; now: number }) {
  const left = Math.max(0, Math.min(100, w.leftPct));
  const reset = resetText(w, now);
  return (
    <span className="m" data-level={levelOf(w.leftPct)} title={reset ?? undefined}>
      <span>{name}</span>
      <i role="meter" aria-label={`${name} left`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(left)}
        aria-valuetext={`${pct(w.leftPct)} left${reset ? `. ${reset}` : ''}`} style={{ ['--left' as string]: left / 100 }} />
      <b>{pct(w.leftPct)}</b>
    </span>
  );
}

/**
 * One provider's limits in the top bar while it is focused (sidebar provider row or a single-provider filter).
 * The meters open that provider's detail (resets, By model); "Usage for all providers" ends the focus.
 */
export function UsageFocus({ provider }: { provider: ProviderId }) {
  const store = useStoreInstance();
  const reading = useStore((s) => s.usage[provider]);
  const now = useStore((s) => s.now);
  const installed = useStore((s) => s.connections[provider]?.installed === true);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const five = windowOf(reading, 'five_hour');
  const week = windowOf(reading, 'weekly');
  const note = chipNote(reading, installed);
  const dim = !reading || reading.status !== 'ok';

  // Clears the focus; when the focus came from a single-provider filter, that filter is the focus, so it goes too.
  const showAll = () =>
    store.setState((s) => {
      const single = s.ui.filters.provider?.length === 1;
      return { ...s, ui: { ...s.ui, focusProvider: null, filters: single ? { ...s.ui.filters, provider: null } : s.ui.filters } };
    });

  return (
    <>
      <button className="usage-focus" type="button" data-dim={dim || undefined} aria-haspopup="dialog" aria-expanded="false"
        aria-label={`${chipLabel(provider, reading, installed)}. Show details`}
        onClick={(e) => { setAnchor(e.currentTarget); setOpen(!open); }}>
        <ProviderLogo id={provider} size="sm" />
        {five && <FocusMeter name="5-hour" w={five} now={now} />}
        {week && <FocusMeter name="Weekly" w={week} now={now} />}
        {!five && !week && note && <span className="m">{note}</span>}
      </button>
      <UsagePopover anchor={anchor} open={open} onClose={() => setOpen(false)} providers={[provider]} label={`${providerName(provider)} usage`} />
      <button className="link-btn" type="button" onClick={showAll}>
        <Icon name="gauge" size="sm" />Usage for all providers
      </button>
    </>
  );
}
