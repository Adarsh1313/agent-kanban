import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
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
        <p>{label} content</p>
      </Popover>
    </>
  );
}
const state = (name: string) => screen.getByRole('dialog', { name, hidden: true }).getAttribute('data-state');

describe('Popover', () => {
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
