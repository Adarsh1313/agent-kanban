import { useEffect, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon.tsx';
import { Popover } from './Popover.tsx';

export interface MenuNav { go: (pane: string) => void; back: () => void; close: () => void }

export interface MenuProps {
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  align?: 'left' | 'right';
  label: string;
  /** Each pane is a screen of the menu; `go` slides to another pane and `back` returns (pane-in animation). */
  panes: Record<string, (nav: MenuNav) => ReactNode>;
  initial?: string;
}

export function Menu({ anchor, open, onClose, align, label, panes, initial = 'root' }: MenuProps) {
  const [trail, setTrail] = useState<string[]>([initial]);
  const [reverse, setReverse] = useState(false);
  useEffect(() => {
    if (!open) {
      setTrail([initial]);
      setReverse(false);
    }
  }, [open, initial]);
  const current = trail[trail.length - 1]!;
  const nav: MenuNav = {
    go: (p) => { setReverse(false); setTrail((t) => [...t, p]); },
    back: () => { setReverse(true); setTrail((t) => (t.length > 1 ? t.slice(0, -1) : t)); },
    close: onClose,
  };
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} align={align} label={label} className="menu" role="menu">
      <div key={current} className={reverse ? 'pane back' : 'pane'}>
        {panes[current]?.(nav)}
      </div>
    </Popover>
  );
}

export interface MenuItemProps {
  children: ReactNode;
  onSelect?: () => void;
  icon?: IconName;
  /** Right-aligned hint (a count, a shortcut, a chevron). */
  right?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  /** Present for check items (Filter options). */
  checked?: boolean;
}

export function MenuItem({ children, onSelect, icon, right, danger, disabled, checked }: MenuItemProps) {
  const isCheck = checked !== undefined;
  return (
    <button
      className={`menu-item${danger ? ' danger' : ''}`}
      type="button"
      role={isCheck ? 'menuitemcheckbox' : 'menuitem'}
      aria-checked={isCheck ? checked : undefined}
      aria-disabled={disabled ? true : undefined}
      onClick={() => { if (!disabled) onSelect?.(); }}
    >
      {isCheck && <span className="box"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg></span>}
      {icon && <Icon name={icon} />}
      {children}
      {right !== undefined && <span className="r">{right}</span>}
    </button>
  );
}

export const MenuLabel = ({ children }: { children: ReactNode }) => <div className="menu-label">{children}</div>;
export const MenuSep = () => <div className="menu-sep" role="separator" />;
