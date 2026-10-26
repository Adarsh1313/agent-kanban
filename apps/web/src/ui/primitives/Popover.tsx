import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { focusInto } from './focus.ts';
import { pushLayer } from './layers.ts';

export interface PopoverProps {
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  align?: 'left' | 'right';
  /** Accessible name. */
  label: string;
  className?: string;
  role?: 'dialog' | 'menu' | 'listbox';
  children: ReactNode;
}

/** Space between the anchor and the popover, and the least space kept from the window's edges. */
const GAP = 6;
const EDGE = 8;

/**
 * The popover's left edge: the asked alignment (its left edge on the anchor's, or right on right), else the other
 * alignment when only that one fits, else clamped inside the window on both sides.
 */
function horizontal(r: DOMRect, w: number, viewport: number, align: 'left' | 'right'): number {
  const max = viewport - w - EDGE;
  const fits = (x: number) => x >= EDGE && x <= max;
  const preferred = align === 'right' ? r.right - w : r.left;
  const flipped = align === 'right' ? r.left : r.right - w;
  if (fits(preferred)) return preferred;
  if (fits(flipped)) return flipped;
  return Math.max(EDGE, Math.min(preferred, max));
}

/**
 * Opens from its anchor (scales from the anchor, never from the centre), closes on an outside press or Escape.
 * Only one popover is open at a time. Stays mounted when closed so it can animate out.
 */
export function Popover({ anchor, open, onClose, align = 'left', label, className = '', role = 'dialog', children }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const place = useCallback(() => {
    const pop = ref.current;
    if (!pop || !anchor) return;
    const r = anchor.getBoundingClientRect();
    const left = horizontal(r, pop.offsetWidth || 300, window.innerWidth, align);
    // The full content height, also while a max-height below makes it scroll (borders included).
    const h = pop.scrollHeight + (pop.offsetHeight - pop.clientHeight);
    const room = { below: window.innerHeight - r.bottom - GAP - EDGE, above: r.top - GAP - EDGE };
    // Below the anchor; above it when it only fits there (the sidebar's Settings sits at the bottom); when it fits
    // neither way (a short window), on the roomier side, capped to that space and scrolling inside.
    const above = h > room.below && (h <= room.above || room.above > room.below);
    const space = Math.max(0, above ? room.above : room.below);
    // data-capped: the popover itself scrolls, so a list inside it must not scroll too (app.css).
    if (h > space) {
      pop.style.maxHeight = `${space}px`;
      pop.style.overflowY = 'auto';
      pop.dataset.capped = '';
    } else {
      pop.style.maxHeight = '';
      pop.style.overflowY = '';
      delete pop.dataset.capped;
    }
    pop.style.position = 'fixed';
    pop.style.top = `${above ? r.top - GAP - Math.min(h, space) : r.bottom + GAP}px`;
    pop.style.left = `${left}px`;
    pop.style.setProperty('--origin', `${r.left + r.width / 2 - left}px ${above ? 'bottom' : 'top'}`);
  }, [anchor, align]);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    // Follow the anchor when the window is resized or anything outside the popover scrolls.
    const onScroll = (e: Event) => { if (!(e.target instanceof Node && ref.current?.contains(e.target))) place(); };
    window.addEventListener('resize', place);
    document.addEventListener('scroll', onScroll, true);
    // Content that changes while open (a model list arriving) can need another height or side.
    const changed = new MutationObserver(place);
    if (ref.current) changed.observe(ref.current, { childList: true, subtree: true, characterData: true });
    return () => {
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', onScroll, true);
      changed.disconnect();
    };
  }, [open, place]);

  useEffect(() => {
    if (!anchor) return;
    anchor.setAttribute('aria-expanded', String(open));
    // When the popover moves to another anchor (or unmounts), the one it leaves is collapsed again.
    return () => anchor.setAttribute('aria-expanded', 'false');
  }, [open, anchor]);

  useEffect(() => {
    const pop = ref.current;
    if (!open || !pop) return;
    const release = pushLayer('popover', () => onCloseRef.current());
    const outside = (e: Event) => {
      const t = e.target as Node | null;
      if (t && (pop.contains(t) || anchor?.contains(t))) return;
      onCloseRef.current();
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('touchstart', outside);
    const restore = focusInto(pop, anchor);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('touchstart', outside);
      release();
      restore();
    };
  }, [open, anchor]);

  return createPortal(
    <div ref={ref} className={`popover ${className}`.trim()} data-state={open ? 'open' : 'closed'} role={role} aria-label={label} inert={!open}>
      {children}
    </div>,
    document.body,
  );
}
