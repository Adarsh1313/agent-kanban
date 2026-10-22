import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { focusInto } from './focus.ts';
import { Icon } from './Icon.tsx';
import { pushLayer } from './layers.ts';
import { Tooltip } from './Tooltip.tsx';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Buttons for the footer row. */
  footer?: ReactNode;
}

/** Modal dialog on a scrim: Escape or a click on the scrim closes it; focus moves in and returns to where it was. */
export function Dialog({ open, onClose, title, children, footer }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const dlg = ref.current;
    if (!open || !dlg) return;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const release = pushLayer('dialog', () => onCloseRef.current());
    const restore = focusInto(dlg, before);
    return () => {
      release();
      restore();
    };
  }, [open]);

  const state = open ? 'open' : 'closed';
  return createPortal(
    <>
      <div className="scrim" data-state={state} onClick={onClose} />
      <div ref={ref} className="dialog" data-state={state} role="dialog" aria-modal="true" aria-labelledby={titleId} inert={!open}>
        <div className="dialog-head">
          <h2 id={titleId}>{title}</h2>
          <Tooltip label="Close"><button className="btn icon-only ghost" type="button" aria-label="Close" onClick={onClose}><Icon name="x" /></button></Tooltip>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </>,
    document.body,
  );
}
