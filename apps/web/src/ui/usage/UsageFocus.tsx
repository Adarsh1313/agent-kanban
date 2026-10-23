import { useState } from 'react';
import type { ProviderId, UsageWindow } from '@agent-kanban/shared';
import { useStore, useStoreInstance } from '../../state/store.ts';
import { Icon, ProviderLogo, providerName } from '../primitives/index.ts';
import { chipLabel, chipNote, levelOf, pct, resetText, windowOf } from './model.ts';
import { UsagePopover } from './UsagePopover.tsx';

/** Decorative: the button's aria-label carries the numbers and reset times (AT doesn't read inside a button). */
function FocusMeter({ name, w, now }: { name: string; w: UsageWindow; now: number }) {
  const left = Math.max(0, Math.min(100, w.leftPct));
  return (
    <span className="m" data-level={levelOf(w.leftPct)} title={resetText(w, now) ?? undefined} aria-hidden="true">
      <span>{name}</span>
      <i style={{ ['--left' as string]: left / 100 }} />
      <b>{pct(w.leftPct)}</b>
    </span>
  );
}

/** "Claude Code: 82% of 5-hour left, 64% of weekly left. 5-hour resets 2:40 pm, weekly resets Thu 9:00 am. Show details" */
function focusLabel(base: string, five: UsageWindow | undefined, week: UsageWindow | undefined, now: number): string {
  const resets = ([['5-hour', five], ['weekly', week]] as const)
    .map(([n, w]) => { const t = w && resetText(w, now); return t ? `${n} ${t.charAt(0).toLowerCase()}${t.slice(1)}` : null; })
    .filter(Boolean);
  return `${base}.${resets.length ? ` ${resets.join(', ')}.` : ''} Show details`;
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
        aria-label={focusLabel(chipLabel(provider, reading, installed), five, week, now)}
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
