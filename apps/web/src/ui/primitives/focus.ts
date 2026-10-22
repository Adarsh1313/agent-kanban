const FOCUSABLE = 'input, textarea, select, button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/** Moves focus into a freshly opened layer; the returned function puts it back on `back` if it is still inside. */
export function focusInto(layer: HTMLElement, back: HTMLElement | null): () => void {
  const first = layer.querySelector<HTMLElement>('[autofocus], ' + FOCUSABLE);
  first?.focus({ preventScroll: true });
  return () => {
    const active = document.activeElement;
    if (back && (layer.contains(active) || active === document.body)) back.focus({ preventScroll: true });
  };
}
