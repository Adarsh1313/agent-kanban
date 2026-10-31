// Where the window opens: last time's size and place, kept on a display that is still connected.

export interface Rect { x: number; y: number; width: number; height: number }
export interface Placement extends Rect { maximized: boolean }

const DEFAULT = { width: 1200, height: 720 };

const overlap = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

const valid = (p: Placement | null): p is Placement => !!p
  && [p.x, p.y, p.width, p.height].every(Number.isFinite) && p.width > 0 && p.height > 0;

/**
 * `displays` are the work areas (taskbar excluded), primary first. A saved window that still touches a
 * display is moved and shrunk to fit fully inside the one it overlaps most; one that touches none (its
 * monitor was unplugged) is centred on the primary display.
 */
export function restorePlacement(saved: Placement | null, displays: Rect[]): Placement {
  const primary = displays[0];
  const wanted = valid(saved) ? saved : { ...DEFAULT, x: 0, y: 0, maximized: false };
  let best: Rect | undefined;
  let bestArea = 0;
  if (valid(saved)) {
    for (const d of displays) {
      const a = overlap(saved, d);
      if (a > bestArea) { best = d; bestArea = a; }
    }
  }
  const area = best ?? primary;
  const width = Math.min(wanted.width, area.width);
  const height = Math.min(wanted.height, area.height);
  if (!best) {
    return { x: area.x + Math.round((area.width - width) / 2), y: area.y + Math.round((area.height - height) / 2), width, height, maximized: wanted.maximized };
  }
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
  return {
    x: clamp(wanted.x, area.x, area.x + area.width - width),
    y: clamp(wanted.y, area.y, area.y + area.height - height),
    width, height, maximized: wanted.maximized,
  };
}
