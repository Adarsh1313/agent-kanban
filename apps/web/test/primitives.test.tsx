import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Popover } from '../src/ui/primitives/Popover.tsx';
import { Tooltip } from '../src/ui/primitives/Tooltip.tsx';
import { Toasts, toast } from '../src/ui/primitives/toast.tsx';
import { Switch } from '../src/ui/primitives/Switch.tsx';
import { Icon } from '../src/ui/primitives/Icon.tsx';
import { StatusIcon } from '../src/ui/primitives/StatusIcon.tsx';
import { ProviderLogo } from '../src/ui/primitives/ProviderLogo.tsx';
import { Dialog } from '../src/ui/primitives/Dialog.tsx';
import { Menu, MenuItem } from '../src/ui/primitives/Menu.tsx';
import { flip } from '../src/ui/primitives/flip.ts';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Pop({ label }: { label: string }) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <button ref={setAnchor} onClick={() => setOpen((o) => !o)}>{label}</button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} label={`${label} popover`}>
        <p>{label} content</p><button>{label} inside</button>
      </Popover>
    </>
  );
}
const state = (name: string) => screen.getByRole('dialog', { name, hidden: true }).getAttribute('data-state');

describe('Popover', () => {
  it('a closed popover is hidden and unreachable: fixed (no scroll range), visibility hidden after the exit fade, inert', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('src/styles/app.css', 'utf8'); // vitest runs from apps/web
    expect(css).toMatch(/\.popover \{ position: fixed; top: 0; left: 0; \}/);
    const closedRule = /\.popover\[data-state="closed"\] \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(closedRule).toContain('visibility: hidden');
    expect(closedRule).toMatch(/visibility 0s linear var\(--duration-exit\)/);
    render(<Pop label="One" />);
    const pop = screen.getByRole('dialog', { name: 'One popover', hidden: true });
    expect(pop.getAttribute('data-state')).toBe('closed');
    expect(pop.hasAttribute('inert')).toBe(true);
  });
  it('opens from its trigger and closes on an outside click', () => {
    render(<><Pop label="One" /><button>elsewhere</button></>);
    fireEvent.click(screen.getByText('One'));
    expect(state('One popover')).toBe('open');
    fireEvent.mouseDown(screen.getByText('elsewhere'));
    expect(state('One popover')).toBe('closed');
  });

  it('stays open for clicks inside it', () => {
    render(<Pop label="One" />);
    fireEvent.click(screen.getByText('One'));
    fireEvent.mouseDown(screen.getByText('One content'));
    expect(state('One popover')).toBe('open');
  });

  it('closes on Escape', () => {
    render(<Pop label="One" />);
    fireEvent.click(screen.getByText('One'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(state('One popover')).toBe('closed');
  });

  it('only one popover is open at a time', () => {
    render(<><Pop label="One" /><Pop label="Two" /></>);
    fireEvent.click(screen.getByText('One'));
    expect(state('One popover')).toBe('open');
    fireEvent.click(screen.getByText('Two'));
    expect(state('Two popover')).toBe('open');
    expect(state('One popover')).toBe('closed');
  });

  it('Escape closes only the top-most layer', () => {
    function Both() {
      const [dlg, setDlg] = useState(true);
      return (
        <>
          <Pop label="One" />
          <Dialog open={dlg} onClose={() => setDlg(false)} title="Hello"><p>body</p></Dialog>
        </>
      );
    }
    render(<Both />);
    fireEvent.click(screen.getByText('One'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(state('One popover')).toBe('closed');
    expect(screen.getByRole('dialog', { name: 'Hello', hidden: true }).getAttribute('data-state')).toBe('open');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'Hello', hidden: true }).getAttribute('data-state')).toBe('closed');
  });
});

describe('Popover placement', () => {
  const realW = window.innerWidth;
  const realH = window.innerHeight;
  const viewport = (w: number, h: number) => {
    Object.defineProperty(window, 'innerWidth', { value: w, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: h, configurable: true });
  };
  afterEach(() => viewport(realW, realH));

  /** jsdom has no layout: give the anchor a box and the popover a size, then open it. */
  function placed(o: { anchor: { left: number; top: number; width?: number; height?: number }; w: number; h: number; align?: 'left' | 'right' }) {
    function P({ open }: { open: boolean }) {
      const [anchor, setAnchor] = useState<HTMLElement | null>(null);
      return (
        <>
          <button ref={setAnchor}>Anchor</button>
          <Popover anchor={anchor} open={open} onClose={() => {}} label="Placed" align={o.align}>
            <button>First</button><button>Second</button>
          </Popover>
        </>
      );
    }
    const view = render(<P open={false} />);
    const { left, top, width = 40, height = 30 } = o.anchor;
    screen.getByText('Anchor').getBoundingClientRect = () =>
      ({ left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
    const pop = screen.getByRole('dialog', { name: 'Placed', hidden: true });
    let h = o.h;
    Object.defineProperty(pop, 'offsetWidth', { get: () => o.w, configurable: true });
    Object.defineProperty(pop, 'scrollHeight', { get: () => h, configurable: true });
    view.rerender(<P open />);
    return { pop, grow: (to: number) => { h = to; } };
  }

  it('one scroller: a capped popover turns off the scrolling of a New chat list inside it', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('src/styles/app.css', 'utf8'); // vitest runs from apps/web
    expect(css).toMatch(/\.dlg-pop\[data-capped\] \.dlg-scroll \{ max-height: none; overflow-y: visible; \}/);
  });

  it('fits below the anchor: placed below with no max-height', () => {
    viewport(1000, 768);
    const { pop } = placed({ anchor: { left: 100, top: 100 }, w: 260, h: 200 });
    expect(pop.style.top).toBe('136px');
    expect(pop.style.maxHeight).toBe('');
    expect(pop.hasAttribute('data-capped')).toBe(false);
    expect(pop.style.overflowY).toBe('');
  });

  it('fits only above: placed above, uncapped', () => {
    viewport(1000, 500);
    const { pop } = placed({ anchor: { left: 100, top: 400 }, w: 260, h: 200 });
    expect(pop.style.top).toBe('194px');
    expect(pop.style.maxHeight).toBe('');
    expect(pop.style.getPropertyValue('--origin')).toMatch(/bottom$/);
  });

  it('a short window: on the roomier side, capped to the space there and scrolling inside; focus still moves in', () => {
    viewport(1000, 500);
    const { pop } = placed({ anchor: { left: 100, top: 300 }, w: 260, h: 400 });
    // Below: 500 - 330 - 6 - 8 = 156; above: 300 - 6 - 8 = 286 → above, 286 px tall, its top 8 px from the window's.
    expect(pop.style.maxHeight).toBe('286px');
    expect(pop.style.overflowY).toBe('auto');
    expect(pop.hasAttribute('data-capped')).toBe(true);
    expect(pop.style.top).toBe('8px');
    expect(pop.contains(document.activeElement)).toBe(true);
  });

  it('below wins a tie of no room either way, capped below', () => {
    viewport(1000, 400);
    const { pop } = placed({ anchor: { left: 100, top: 100 }, w: 260, h: 900 });
    // Below: 400 - 130 - 14 = 256; above: 100 - 14 = 86.
    expect(pop.style.top).toBe('136px');
    expect(pop.style.maxHeight).toBe('256px');
  });

  it('content that grows while open is placed again', async () => {
    viewport(1000, 500);
    const { pop, grow } = placed({ anchor: { left: 100, top: 100 }, w: 260, h: 100 });
    expect(pop.style.maxHeight).toBe('');
    grow(600);
    await act(async () => { pop.appendChild(document.createElement('div')); await Promise.resolve(); });
    expect(pop.style.maxHeight).toBe('356px');
  });

  it('a right-aligned popover wider than the room left of its trigger flips to left alignment', () => {
    viewport(1000, 768);
    const { pop } = placed({ anchor: { left: 20, top: 100 }, w: 260, h: 100, align: 'right' });
    expect(pop.style.left).toBe('20px');
  });

  it('a left-aligned popover near the right edge flips to right alignment', () => {
    viewport(1000, 768);
    const { pop } = placed({ anchor: { left: 900, top: 100 }, w: 260, h: 100 });
    expect(pop.style.left).toBe('680px'); // 940 - 260
  });

  it('fits neither way: clamped inside the window on both sides', () => {
    viewport(300, 768);
    const right = placed({ anchor: { left: 120, top: 100 }, w: 260, h: 100, align: 'right' });
    // Right-aligned: 160 - 260 < 8; left-aligned: 120 > 300 - 260 - 8 = 32 → clamped, the left edge kept in view.
    expect(right.pop.style.left).toBe('8px');
    cleanup();
    const wide = placed({ anchor: { left: 120, top: 100 }, w: 400, h: 100 });
    expect(wide.pop.style.left).toBe('8px');
  });
});

describe('Menu', () => {
  it('moves between panes with back', () => {
    render(
      <Menu anchor={document.body} open onClose={() => {}} label="Test menu" panes={{
        root: ({ go }) => <MenuItem onSelect={() => go('sub')}>Open sub</MenuItem>,
        sub: ({ back }) => <MenuItem onSelect={back}>Back to root</MenuItem>,
      }} />,
    );
    fireEvent.click(screen.getByText('Open sub'));
    expect(screen.queryByText('Open sub')).toBeNull();
    fireEvent.click(screen.getByText('Back to root'));
    expect(screen.getByText('Open sub')).toBeTruthy();
  });

  it('a disabled item does not select', () => {
    const onSelect = vi.fn();
    render(<Menu anchor={document.body} open onClose={() => {}} label="m" panes={{ root: () => <MenuItem disabled onSelect={onSelect}>Nope</MenuItem> }} />);
    fireEvent.click(screen.getByText('Nope'));
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('Tooltip', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.querySelectorAll('.tip').forEach((n) => n.remove());
  });
  const tip = () => document.querySelector('.tip') as HTMLElement | null;

  it('shows after 450 ms the first time', () => {
    render(<Tooltip label="Notifications"><button>bell</button></Tooltip>);
    fireEvent.mouseEnter(screen.getByText('bell'));
    act(() => { vi.advanceTimersByTime(449); });
    expect(tip()?.getAttribute('data-state') ?? 'closed').toBe('closed');
    act(() => { vi.advanceTimersByTime(1); });
    expect(tip()?.getAttribute('data-state')).toBe('open');
    expect(tip()?.textContent).toBe('Notifications');
  });

  it('shows instantly for a neighbour within 400 ms, and slowly again after that', () => {
    render(<><Tooltip label="First"><button>a</button></Tooltip><Tooltip label="Second"><button>b</button></Tooltip></>);
    fireEvent.mouseEnter(screen.getByText('a'));
    act(() => { vi.advanceTimersByTime(450); });
    fireEvent.mouseLeave(screen.getByText('a'));
    expect(tip()?.getAttribute('data-state')).toBe('closed');
    act(() => { vi.advanceTimersByTime(300); });
    fireEvent.mouseEnter(screen.getByText('b'));
    act(() => { vi.advanceTimersByTime(0); });
    expect(tip()?.getAttribute('data-state')).toBe('open');
    expect(tip()?.textContent).toBe('Second');
    expect(tip()?.classList.contains('instant')).toBe(true);
    fireEvent.mouseLeave(screen.getByText('b'));
    act(() => { vi.advanceTimersByTime(401); });
    fireEvent.mouseEnter(screen.getByText('a'));
    act(() => { vi.advanceTimersByTime(100); });
    expect(tip()?.getAttribute('data-state')).toBe('closed');
  });

  it('leaving before the delay cancels it', () => {
    render(<Tooltip label="Gone"><button>x</button></Tooltip>);
    fireEvent.mouseEnter(screen.getByText('x'));
    act(() => { vi.advanceTimersByTime(200); });
    fireEvent.mouseLeave(screen.getByText('x'));
    act(() => { vi.advanceTimersByTime(500); });
    expect(tip()?.getAttribute('data-state') ?? 'closed').toBe('closed');
  });
});

describe('toast', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('shows the message, then leaves after 5 s', () => {
    render(<Toasts />);
    act(() => { toast('Pinned to the sidebar'); });
    expect(screen.getByText('Pinned to the sidebar')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(4999); });
    expect(screen.getByText('Pinned to the sidebar')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.queryByText('Pinned to the sidebar')).toBeNull();
  });

  it('pauses while hovered and finishes the remaining time after', () => {
    render(<Toasts />);
    act(() => { toast('Archived'); });
    const el = screen.getByText('Archived').closest('.toast')!;
    act(() => { vi.advanceTimersByTime(3000); });
    fireEvent.mouseEnter(el);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByText('Archived')).toBeTruthy();
    fireEvent.mouseLeave(el);
    act(() => { vi.advanceTimersByTime(1900); });
    expect(screen.getByText('Archived')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.queryByText('Archived')).toBeNull();
  });

  it('runs the action and dismisses', () => {
    render(<Toasts />);
    const run = vi.fn();
    act(() => { toast('Archived', { label: 'Undo', run }); });
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(run).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.queryByText('Archived')).toBeNull();
  });
});

describe('small primitives', () => {
  it('Switch toggles aria-checked through onChange', () => {
    const onChange = vi.fn();
    render(<Switch checked={false} onChange={onChange} label="Sound" />);
    const sw = screen.getByRole('switch', { name: 'Sound' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('Icon draws the design icon and is hidden from assistive tech', () => {
    const { container } = render(<Icon name="board" size="sm" />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('class')).toBe('icon sm');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.querySelectorAll('rect').length).toBe(3);
  });

  it('StatusIcon renders each column state', () => {
    const { container } = render(<><StatusIcon state="running" /><StatusIcon state="needs_you" /><StatusIcon state="review" /><StatusIcon state="done" /></>);
    expect(container.querySelectorAll('svg.status').length).toBe(4);
    expect(container.querySelector('svg.running circle.arc')).toBeTruthy();
    const glyphs = [...container.querySelectorAll('path[stroke], circle[fill="var(--color-on-status)"]')].filter((n) => n.getAttribute('stroke') === 'var(--color-on-status)' || n.getAttribute('fill') === 'var(--color-on-status)');
    expect(glyphs.length).toBe(3);
  });

  it('ProviderLogo points at the shipped svg', () => {
    const { container } = render(<ProviderLogo id="codex" size="sm" />);
    const img = container.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('/providers/codex-color.svg');
    expect(img.className).toBe('logo sm');
  });

  it('flip resolves without animation support (jsdom) and runs the mutation', async () => {
    const el = document.createElement('div');
    document.body.append(el);
    const mutate = vi.fn();
    await flip([el], mutate);
    expect(mutate).toHaveBeenCalledTimes(1);
    el.remove();
  });
});

describe('toast lifecycle', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('auto-dismisses under StrictMode (effects run twice)', () => {
    render(<StrictMode><Toasts /></StrictMode>);
    act(() => { toast('Strict toast'); });
    act(() => { vi.advanceTimersByTime(5200); });
    expect(screen.queryByText('Strict toast')).toBeNull();
  });

  const setHidden = (hidden: boolean) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    document.dispatchEvent(new Event('visibilitychange'));
  };
  afterEach(() => { Reflect.deleteProperty(document, 'hidden'); });

  it('pauses while the page is hidden and resumes with the time left', () => {
    render(<Toasts />);
    act(() => { toast('Hidden toast'); });
    act(() => { vi.advanceTimersByTime(3000); });
    act(() => { setHidden(true); });
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByText('Hidden toast')).toBeTruthy();
    act(() => { setHidden(false); });
    act(() => { vi.advanceTimersByTime(1900); });
    expect(screen.getByText('Hidden toast')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.queryByText('Hidden toast')).toBeNull();
  });

  it('becoming visible does not restart the timer while the toast is hovered', () => {
    render(<Toasts />);
    act(() => { toast('Held toast'); });
    const el = screen.getByText('Held toast').closest('.toast')!;
    fireEvent.mouseEnter(el);
    act(() => { setHidden(true); });
    act(() => { setHidden(false); });
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByText('Held toast')).toBeTruthy();
  });
});

describe('focus, dialog and motion', () => {
  it('returns focus to the anchor when a popover closes', () => {
    render(<Pop label="One" />);
    const trigger = screen.getByText('One');
    trigger.focus();
    fireEvent.click(trigger);
    expect(document.activeElement).not.toBe(trigger);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(trigger);
  });

  it('a dialog traps Tab and makes the rest of the page inert', () => {
    const root = document.createElement('div');
    document.body.append(root);
    render(<Dialog open onClose={() => {}} title="Trap"><input aria-label="one" /></Dialog>, { container: root });
    expect(root.inert).toBe(true);
    const close = screen.getByRole('button', { name: 'Close', hidden: true });
    const input = screen.getByLabelText('one');
    input.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(input);
    cleanup();
    expect(root.inert).toBeFalsy();
    root.remove();
  });

  it('a popover opened from a dialog stays usable and keeps Tab inside itself', () => {
    render(<Dialog open onClose={() => {}} title="Host"><Pop label="Pick" /></Dialog>);
    fireEvent.click(screen.getByText('Pick'));
    const inside = screen.getByText('Pick inside');
    expect(inside.closest('[inert]')).toBeNull();
    expect(document.activeElement).toBe(inside);
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(inside);
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(inside);
  });

  it('a toast shown while a dialog is open is not inert', () => {
    render(<><Dialog open onClose={() => {}} title="Host"><p>x</p></Dialog><Toasts /></>);
    act(() => { toast('Saved while open'); });
    expect(screen.getByText('Saved while open').closest('[inert]')).toBeNull();
    cleanup();
  });

  it('nested dialogs unfreeze in order', () => {
    const root = document.createElement('div');
    document.body.append(root);
    function Two({ a, b }: { a: boolean; b: boolean }) {
      return (
        <>
          <Dialog open={a} onClose={() => {}} title="A"><p>a</p></Dialog>
          <Dialog open={b} onClose={() => {}} title="B"><p>b</p></Dialog>
        </>
      );
    }
    const { rerender } = render(<Two a b={false} />, { container: root });
    const dlg = (n: string) => screen.getByRole('dialog', { name: n, hidden: true });
    expect(root.inert).toBe(true);
    rerender(<Two a b />);
    expect(dlg('A').inert).toBe(true);
    expect(dlg('B').inert).toBeFalsy();
    rerender(<Two a b={false} />);
    expect(root.inert).toBe(true);
    expect(dlg('A').inert).toBeFalsy();
    rerender(<Two a={false} b={false} />);
    expect(root.inert).toBeFalsy();
    cleanup();
    root.remove();
  });

  it('flip does not animate under prefers-reduced-motion', async () => {
    const mm = vi.fn().mockReturnValue({ matches: true });
    vi.stubGlobal('matchMedia', mm);
    const el = document.createElement('div');
    const animate = vi.fn();
    el.animate = animate as never;
    document.body.append(el);
    const mutate = vi.fn();
    await flip([el], mutate);
    expect(mutate).toHaveBeenCalled();
    expect(animate).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    el.remove();
  });
});
