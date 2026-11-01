import { forwardRef, useId, useState } from 'react';
import type { Chat, ProviderId } from '@agent-kanban/shared';
import { api } from '../../api/client.ts';
import { useStore, useStoreInstance } from '../../state/store.ts';
import { PROVIDER_IDS, providerName } from '../primitives/index.ts';
import { runAction } from './ChatActionsMenu.tsx';
import { Composer } from './Composer.tsx';

/** What the new provider gets on a handoff (decision 6). */
export const handoffNote = (id: ProviderId) => `${providerName(id)} will get the last messages, your spec's progress and project notes.`;

/**
 * A board chat's composer with the provider picker. Picking another provider only shows the note; the chat
 * switches on send (#40).
 */
export const ChatComposer = forwardRef<HTMLTextAreaElement, { chat: Chat; hint: string; placeholder: string; skills: string[] }>(
  function ChatComposer({ chat, hint, placeholder, skills }, ref) {
    const store = useStoreInstance();
    const [to, setTo] = useState<ProviderId>(chat.provider);
    const noteId = useId();
    const switching = to !== chat.provider;
    const send = async (text: string) => {
      return runAction(store, () => (switching ? api.send(chat.id, text, to) : api.send(chat.id, text)));
    };
    const tools = (
      <select className="provider-pick" aria-label="Provider" value={to} aria-describedby={switching ? noteId : undefined} onChange={(e) => setTo(e.target.value as ProviderId)}>
        {PROVIDER_IDS.map((id) => <option key={id} value={id}>{providerName(id)}</option>)}
      </select>
    );
    return (
      <>
        <div className="handoff-note" id={noteId} role="status">{switching ? handoffNote(to) : ''}</div>
        <Composer ref={ref} onSend={send} hint={hint} placeholder={placeholder} skills={skills} tools={tools} />
      </>
    );
  },
);

/** Out of usage: one click hands the chat to the provider with the most room. */
export function ContinueWith({ chat }: { chat: Chat }) {
  const store = useStoreInstance();
  const suggested = useStore((s) => s.suggested);
  const other = suggested && suggested !== chat.provider ? suggested : PROVIDER_IDS.find((id) => id !== chat.provider)!;
  if (chat.needsReason !== 'limit') return null;
  return (
    <div className="thread-note limit-nudge">
      <span className="grow">{providerName(chat.provider)} is out of usage. {handoffNote(other)}</span>
      <button className="btn" type="button" onClick={() => void runAction(store, () => api.send(chat.id, 'Continue where the last agent left off.', other))}>
        Continue with {providerName(other)}
      </button>
    </div>
  );
}
