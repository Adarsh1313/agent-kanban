/**
 * The stack of open popovers, dialogs and the chat panel. Escape closes the top-most one; opening a
 * popover closes any other popover (one at a time), while a popover opened over a dialog or the panel
 * leaves it open.
 */
interface Layer { kind: 'popover' | 'dialog' | 'panel'; close: () => void }

const stack: Layer[] = [];
let listening = false;

function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape') return;
  stack[stack.length - 1]?.close();
}

export function pushLayer(kind: Layer['kind'], close: () => void): () => void {
  if (!listening) {
    document.addEventListener('keydown', onKey);
    listening = true;
  }
  if (kind === 'popover') for (const l of [...stack]) if (l.kind === 'popover') l.close();
  const layer: Layer = { kind, close };
  stack.push(layer);
  return () => {
    const i = stack.indexOf(layer);
    if (i !== -1) stack.splice(i, 1);
  };
}

/** A popover or dialog is open (the side panel does not count: shortcuts such as N still work beside it). */
export const hasOpenLayer = (): boolean => stack.some((l) => l.kind !== 'panel');
