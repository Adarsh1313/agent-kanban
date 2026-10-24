const KEY = 'agent-kanban.theme';
type Theme = 'light' | 'dark';

const root = () => document.documentElement;
const isTheme = (v: unknown): v is Theme => v === 'light' || v === 'dark';

function remembered(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return isTheme(v) ? v : null;
  } catch {
    return null;
  }
}

/** Puts the remembered choice on <html>; with none, the system setting (prefers-color-scheme) applies through the CSS. */
export function applySavedTheme(): void {
  const t = remembered();
  if (t) root().dataset.theme = t;
}

export function toggleTheme(): Theme {
  const current = isTheme(root().dataset.theme)
    ? root().dataset.theme
    : typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  const next: Theme = current === 'dark' ? 'light' : 'dark';
  root().dataset.theme = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // Private window or blocked storage: the choice just is not remembered.
  }
  return next;
}
