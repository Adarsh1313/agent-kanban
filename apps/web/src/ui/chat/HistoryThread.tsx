import { useEffect, useState } from 'react';
import { api, type Transcript } from '../../api/client.ts';
import type { HistoryRef } from '../../state/reducer.ts';
import { useStore } from '../../state/store.ts';
import { clockTime } from '../board/format.ts';
import { ProviderLogo, StatusIcon } from '../primitives/index.ts';
import { Markdown } from './Markdown.tsx';

/**
 * A chat that is only in the provider's history: its past messages, read from the provider's own files and shown
 * read-only, above the composer that carries it on here (#16). Antigravity's history can't be read as messages, so it
 * keeps the note that they are in its app.
 */
export function HistoryThread({ historyRef, app }: { historyRef: HistoryRef; app: string }) {
  const now = useStore((s) => s.now);
  const [state, setState] = useState<{ status: 'loading' } | { status: 'ready'; t: Transcript } | { status: 'failed' }>({ status: 'loading' });
  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    api.historyMessages(historyRef.provider, historyRef.sessionRef).then(
      (t) => { if (live) setState({ status: 'ready', t }); },
      () => { if (live) setState({ status: 'failed' }); },
    );
    return () => { live = false; };
  }, [historyRef.provider, historyRef.sessionRef]);

  const elsewhere = <div className="thread-note center">Earlier messages are in {app}. Send a message to carry on here.</div>;
  if (state.status === 'loading') {
    return <div className="thread" aria-busy="true"><div className="thread-note center"><StatusIcon state="running" />Loading earlier messages…</div></div>;
  }
  if (state.status === 'failed' || state.t.unavailable || state.t.messages.length === 0) return <div className="thread">{elsewhere}</div>;
  const { messages, truncated } = state.t;
  return (
    <div className="thread history-thread">
      {truncated && <div className="thread-note center">Showing the last {messages.length} messages. The rest are in {app}.</div>}
      {messages.map((m, i) => (m.role === 'user' ? (
        <div className="msg user" key={i}>
          <div className="msg-text">{m.text}</div>
          {m.at && <time className="msg-time" dateTime={m.at}>{clockTime(m.at, now)}</time>}
        </div>
      ) : (
        <div className="msg agent" key={i}>
          <div className="who">
            <ProviderLogo id={historyRef.provider} size="sm" />{app}
            {m.at && <time className="msg-time" dateTime={m.at}>{clockTime(m.at, now)}</time>}
          </div>
          <div className="msg-text md"><Markdown text={m.text} /></div>
        </div>
      )))}
      <div className="thread-note center">Send a message to carry on this chat here.</div>
    </div>
  );
}
