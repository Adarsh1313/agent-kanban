import { cloneElement, useEffect, type FocusEvent, type MouseEvent, type ReactElement } from 'react';

const FIRST_DELAY = 450;
const WARM_WINDOW = 400;

let tipEl: HTMLDivElement | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let warmUntil = 0;
let active: HTMLElement | null = null;

function el(): HTMLDivElement {
  if (!tipEl || !tipEl.isConnected) {
    tipEl = document.createElement('div');
    tipEl.className = 'tip';
    tipEl.dataset.state = 'closed';
    tipEl.setAttribute('role', 'tooltip');
    document.body.append(tipEl);
  }
  return tipEl;
}

/** The first tooltip waits 450 ms; moving to a neighbour within 400 ms shows the next one instantly. */
function show(target: HTMLElement, label: string) {
  const tip = el();
  const warm = Date.now() < warmUntil;
  clearTimeout(timer);
  active = target;
  timer = setTimeout(() => {
    tip.textContent = label;
    tip.classList.toggle('instant', warm);
    const r = target.getBoundingClientRect();
    tip.style.left = `${Math.max(8, r.left + r.width / 2 - tip.offsetWidth / 2)}px`;
    const below = r.bottom + 6;
    const fits = below + (tip.offsetHeight || 0) <= window.innerHeight;
    tip.style.top = `${fits ? below : r.top - 6 - tip.offsetHeight}px`;
    tip.style.setProperty('--origin', fits ? 'top center' : 'bottom center');
    tip.dataset.state = 'open';
  }, warm ? 0 : FIRST_DELAY);
}

function hide(target?: HTMLElement) {
  if (target && active !== target) return;
  clearTimeout(timer);
  active = null;
  const tip = tipEl;
  if (tip && tip.dataset.state === 'open') warmUntil = Date.now() + WARM_WINDOW;
  if (tip) tip.dataset.state = 'closed';
}

interface TipChildProps {
  onMouseEnter?: (e: MouseEvent<HTMLElement>) => void;
  onMouseLeave?: (e: MouseEvent<HTMLElement>) => void;
  onFocus?: (e: FocusEvent<HTMLElement>) => void;
  onBlur?: (e: FocusEvent<HTMLElement>) => void;
}

const keyboardFocus = (target: HTMLElement) => {
  try {
    return target.matches(':focus-visible');
  } catch {
    return false;
  }
};

/** Wraps one element (no extra DOM). Icon-only buttons also keep their own aria-label. */
export function Tooltip({ label, children }: { label: string; children: ReactElement<TipChildProps> }) {
  useEffect(() => () => hide(), []);
  const own = children.props;
  return cloneElement(children, {
    onMouseEnter: (e) => { own.onMouseEnter?.(e); show(e.currentTarget, label); },
    onMouseLeave: (e) => { own.onMouseLeave?.(e); hide(e.currentTarget); },
    onFocus: (e) => { own.onFocus?.(e); if (keyboardFocus(e.currentTarget)) show(e.currentTarget, label); },
    onBlur: (e) => { own.onBlur?.(e); hide(e.currentTarget); },
  });
}
