import { useCallback, useEffect, useRef, useState } from 'react';
import { unreadCount } from '../../state/selectors.ts';
import { useStore } from '../../state/store.ts';
import { Icon, Tooltip } from '../primitives/index.ts';
import { NotificationsPopover, useNotifyPrefs } from './NotificationsPopover.tsx';
import { onRing } from './notifier.ts';

/** The top bar's bell: unread count, one damped ring per new notification, and the notifications popover. */
export function Bell() {
  const unread = useStore(unreadCount);
  const prefs = useNotifyPrefs();
  const ref = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [enterId, setEnterId] = useState<string | null>(null);
  const setButton = useCallback((el: HTMLButtonElement | null) => {
    ref.current = el;
    setAnchor(el);
  }, []);

  useEffect(() => onRing((id) => {
    setEnterId(id);
    const el = ref.current;
    if (!el) return;
    // Restart the animation when a ring lands while the last one is still swinging.
    el.classList.remove('ring');
    void el.offsetWidth;
    el.classList.add('ring');
  }), []);

  return (
    <>
      <Tooltip label="Notifications">
        <button
          ref={setButton}
          className="btn icon-only ghost bell"
          type="button"
          aria-haspopup="dialog"
          aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
          onClick={() => {
            if (open) setEnterId(null);
            setOpen(!open);
          }}
          onAnimationEnd={(e) => e.currentTarget.classList.remove('ring')}
        >
          <Icon name={prefs.desktop || prefs.sound ? 'bell' : 'bell-off'} />
          <span className="dot" data-n={unread} aria-hidden="true">{unread}</span>
        </button>
      </Tooltip>
      <NotificationsPopover
        anchor={anchor}
        open={open}
        onClose={() => {
          setOpen(false);
          setEnterId(null);
        }}
        enterId={enterId}
        onEntered={() => setEnterId(null)}
      />
    </>
  );
}
