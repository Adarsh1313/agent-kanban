import { cssMs, cssValue, reducedMotion } from './motion.ts';

/** FLIP: measure, change the DOM, animate each element from where it was. Port of design/components.js flip(). */
export function flip(elements: Iterable<HTMLElement>, mutate: () => void, { lift }: { lift?: HTMLElement } = {}): Promise<void> {
  const els = [...elements];
  const first = new Map(els.map((el) => [el, el.getBoundingClientRect()]));
  mutate();
  if (reducedMotion()) return Promise.resolve();
  const dur = cssMs('--duration-move', 260);
  const easing = cssValue('--ease-in-out', 'ease-in-out');
  return Promise.all(els.map((el) => {
    if (typeof el.animate !== 'function') return Promise.resolve();
    const a = first.get(el)!;
    const b = el.getBoundingClientRect();
    const dx = a.left - b.left;
    const dy = a.top - b.top;
    if (!dx && !dy) return Promise.resolve();
    const isLift = lift === el;
    if (isLift) el.classList.add('lifted');
    const anim = el.animate(
      [
        { transform: `translate(${dx}px, ${dy}px)${isLift ? ` scale(${cssValue('--lift-scale', '1.02')})` : ''}` },
        { transform: 'translate(0, 0) scale(1)' },
      ],
      { duration: dur, easing },
    );
    return anim.finished.catch(() => {}).then(() => { el.classList.remove('lifted'); });
  })).then(() => {});
}
