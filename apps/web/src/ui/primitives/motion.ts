const root = () => document.documentElement;

/** Reads a duration token from tokens.css (e.g. `--duration-exit`) in ms; `fallback` when the stylesheet is absent (tests). */
export function cssMs(name: string, fallback: number): number {
  const v = parseFloat(getComputedStyle(root()).getPropertyValue(name));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export function cssValue(name: string, fallback: string): string {
  return getComputedStyle(root()).getPropertyValue(name).trim() || fallback;
}

export const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
