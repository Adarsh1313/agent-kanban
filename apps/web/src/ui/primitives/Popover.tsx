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
    const w = pop.offsetWidth || 300;
    const left = Math.max(8, Math.min(align === 'right' ? r.right - w : r.left, window.innerWidth - w - 8));
    const h = pop.offsetHeight;
    // Below the anchor; above it when there is no room below (the sidebar's Settings sits at the bottom).
    const above = r.bottom + 6 + h > window.innerHeight && r.top - 6 - h >= 8;
    pop.style.position = 'fixed';
    pop.style.top = `${above ? r.top - 6 - h : r.bottom + 6}px`;
    pop.style.left = `${left}px`;
    pop.style.setProperty('--origin', `${r.left + r.width / 2 - left}px ${above ? 'bottom' : 'top'}`);
  }, [anchor, align]);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    // Follow the anchor when the window is resized or anything scrolls.
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', place, true);
    };
  }, [open, place]);

  useEffect(() => {
    anchor?.setAttribute('aria-expanded', String(open));
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
