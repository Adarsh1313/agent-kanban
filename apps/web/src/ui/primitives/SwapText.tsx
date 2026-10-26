import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cssMs, reducedMotion } from './motion.ts';

/**
 * Crossfades a line of text through a short blur when it changes (design swapText, --duration-swap):
 * "out" blurs the old text away, then the new text starts from "in" and transitions to rest.
 * With reduced motion the text is replaced at once. `render` wraps the shown text (e.g. with an icon).
 */
export function SwapText({ text, className, title, render }: {
  text: string;
  className: string;
  /** Shows the text as a tooltip too (for lines that may be cut off). */
  title?: boolean;
  render?: (shown: string) => ReactNode;
}) {
  const [shown, setShown] = useState(text);
  const [phase, setPhase] = useState<'' | 'out' | 'in'>('');
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (text === shown) {
      setPhase((p) => (p === 'out' ? '' : p));
      return;
    }
    if (reducedMotion()) {
      setShown(text);
      setPhase('');
      return;
    }
    setPhase('out');
    const t = setTimeout(() => {
      setShown(text);
      setPhase('in');
    }, cssMs('--duration-swap', 200));
    return () => clearTimeout(t);
    // `shown` is read only to skip a change back to the text already shown.
  }, [text]);
  // Commit the "in" start state, flush styles, then drop it so the entrance transitions.
  useLayoutEffect(() => {
    if (phase !== 'in') return;
    void ref.current?.offsetWidth;
    setPhase('');
  }, [phase]);
  return <span className={phase ? `${className} ${phase}` : className} ref={ref} title={title ? shown : undefined}>{render ? render(shown) : shown}</span>;
}
