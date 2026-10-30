import type { OpenRequest, ProviderId } from '@agent-kanban/shared';
import { useState, type KeyboardEvent } from 'react';
import { api, type AnswerDecision } from '../../api/client.ts';
import { useStoreInstance } from '../../state/store.ts';
import { Icon, StatusIcon, providerName } from '../primitives/index.ts';
import { permissionText } from '../notify/notifier.ts';
import { runAction } from './ChatActionsMenu.tsx';
import { inFolder } from '../board/format.ts';

/**
 * Something the agent is waiting on. A permission gets Allow / Deny; a question gets a reply box.
 * The card stays (with its buttons disabled) until the server says the request is closed.
 */
export function RequestCard({ chatId, provider, cwd = '', request }: { chatId: string; provider: ProviderId; cwd?: string; request: OpenRequest }) {
  const store = useStoreInstance();
  const [busy, setBusy] = useState<null | 'allow' | 'deny' | 'reply'>(null);
  const [answered, setAnswered] = useState(false);
  const [reply, setReply] = useState('');

  const answer = async (kind: 'allow' | 'deny' | 'reply', decision: AnswerDecision) => {
    if (busy || answered) return;
    setBusy(kind);
    const ok = await runAction(store, () => api.answer(chatId, request.requestId, decision));
    setBusy(null);
    if (ok) setAnswered(true);
  };

  const sendReply = () => {
    const text = reply.trim();
    if (text) void answer('reply', { reply: text });
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
      e.preventDefault();
      sendReply();
    }
  };
  const locked = busy !== null || answered;

  if (request.kind === 'permission') {
    return (
      <div className="request" role="group" aria-label="Permission request">
        <div className="request-head"><StatusIcon state="needs" />{providerName(provider)} {permissionText(request.action)}</div>
        <div className="cmd" title={request.summary}>{inFolder(request.summary, cwd)}</div>
        <div className="row">
          <button className="btn primary" type="button" disabled={locked} onClick={() => void answer('allow', 'allow')}>{busy === 'allow' ? 'Allowing…' : 'Allow'}</button>
          <button className="btn" type="button" disabled={locked} onClick={() => void answer('deny', 'deny')}>{busy === 'deny' ? 'Denying…' : 'Deny'}</button>
        </div>
      </div>
    );
  }
  return (
    <div className="request" role="group" aria-label="Question">
      <div className="request-head"><StatusIcon state="needs" />{request.summary}</div>
      <div className="request-note">Reply and the agent carries on.</div>
      <div className="composer-box">
        <textarea className="request-reply" aria-label="Reply" placeholder="Your answer" rows={2} value={reply} disabled={locked}
          onChange={(e) => setReply(e.target.value)} onKeyDown={onKey} />
        <div className="composer-row">
          <span className="grow">Enter to send · Shift+Enter for a new line</span>
          <button className="btn primary icon-only" type="button" aria-label="Send reply" disabled={locked || !reply.trim()} onClick={sendReply}><Icon name="send" /></button>
        </div>
      </div>
    </div>
  );
}
