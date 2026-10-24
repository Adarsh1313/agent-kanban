import { useId, useState, useSyncExternalStore } from 'react';
import { markAllNotificationsRead } from '../../state/reducer.ts';
import { useStore, useStoreInstance } from '../../state/store.ts';
import { relativeTime } from '../board/format.ts';
import { Icon, Popover, ProviderLogo, Switch } from '../primitives/index.ts';
import { chime, desktopSupport, enableDesktop, getPrefs, notificationText, notificationTitle, openNotification, primeAudio, setPrefs, subscribePrefs } from './notifier.ts';

export const useNotifyPrefs = () => useSyncExternalStore(subscribePrefs, getPrefs, getPrefs);

const BLOCKED = 'Notifications are blocked in your browser settings.';
const UNSUPPORTED = 'Not supported in this browser.';

function Rows({ enterId, onOpen }: { enterId: string | null; onOpen: () => void }) {
  const store = useStoreInstance();
  const rows = useStore((s) => s.notifications.map((n) => ({
    n,
    title: notificationTitle(s, n),
    text: notificationText(s, n),
    provider: s.chats[n.chatId]?.provider ?? null,
    when: relativeTime(n.at, s.now),
  })));
  if (rows.length === 0) return <div className="notif-empty">You're all caught up.</div>;
  return (
    <>
      {rows.map(({ n, title, text, provider, when }) => (
        <button
          key={n.id}
          className={['notif', n.unread && 'unread', n.id === enterId && 'enter'].filter(Boolean).join(' ')}
          type="button"
          data-id={n.id}
          onClick={() => {
            openNotification(store, n);
            onOpen();
          }}
        >
          {provider ? <ProviderLogo id={provider} /> : <Icon name="bell" />}
          <span className="body"><b>{title}</b><small>{text}</small></span>
          <span className="when">{n.unread && <span className="sr-only">Unread, </span>}{when}</span>
        </button>
      ))}
    </>
  );
}

function DesktopRow() {
  const prefs = useNotifyPrefs();
  const [support, setSupport] = useState(desktopSupport);
  const noteId = useId();
  const on = prefs.desktop && support === 'granted';
  const reason = support === 'unsupported' ? UNSUPPORTED : support === 'denied' ? BLOCKED : null;

  const change = async (next: boolean) => {
    if (!next) {
      setPrefs({ desktop: false });
      return;
    }
    setSupport(await enableDesktop());
  };

  return (
    <>
      <div className="toggle-row">
        <Icon name="bell" size="sm" /><span>Desktop notifications</span>
        <Switch checked={on} onChange={(v) => void change(v)} label="Desktop notifications" disabled={support === 'unsupported'} describedBy={reason ? noteId : undefined} />
      </div>
      {reason && <p className="toggle-note" id={noteId}>{reason}</p>}
    </>
  );
}

function SoundRow() {
  const prefs = useNotifyPrefs();
  return (
    <div className="toggle-row">
      <Icon name="volume" size="sm" /><span>Sound</span>
      <Switch
        checked={prefs.sound}
        label="Sound"
        onChange={(v) => {
          setPrefs({ sound: v });
          // The switch is a gesture: create the audio context now and play a preview.
          if (v) {
            primeAudio();
            chime(true);
          }
        }}
      />
    </div>
  );
}

export function NotificationsPopover({ anchor, open, onClose, enterId }: { anchor: HTMLElement | null; open: boolean; onClose: () => void; enterId: string | null }) {
  const store = useStoreInstance();
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} align="right" label="Notifications" className="notif-pop">
      <div className="notif-head">
        <b>Notifications</b>
        <button className="link-btn" type="button" onClick={() => store.setState(markAllNotificationsRead)}>Mark all read</button>
      </div>
      <div className="notif-list"><Rows enterId={enterId} onOpen={onClose} /></div>
      <div className="notif-foot">
        <DesktopRow />
        <SoundRow />
      </div>
    </Popover>
  );
}
