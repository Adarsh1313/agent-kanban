import type { Chat, Message, OpenRequest, ProviderId, ToolCall } from '@agent-kanban/shared';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AppState } from '../../state/reducer.ts';
import { useStore } from '../../state/store.ts';
import { clockTime, inFolder, toolIcon } from '../board/format.ts';
import { Markdown } from './Markdown.tsx';
import { Icon, ProviderLogo, StatusIcon, providerName } from '../primitives/index.ts';
import { RequestCard } from './RequestCard.tsx';
import { EFFORT_LABEL } from './EffortPicker.tsx';

/** The thread renders the latest this-many messages; "Show earlier" adds this many more. */
export const THREAD_PAGE = 200;
/** Within this distance of the bottom the thread follows new text. */
const STICK_PX = 48;

const EMPTY_MESSAGES: Message[] = [];
const EMPTY_CALLS: ToolCall[] = [];
const EMPTY_REQUESTS: OpenRequest[] = [];
const EMPTY_STREAMING: Record<string, string> = {};

interface Turn {
  key: string;
  start: string;
  user: Message | null;
  replies: (Pick<Message, 'id' | 'text' | 'effort' | 'suggestions' | 'provider'> & { createdAt: string | null })[];
  calls: ToolCall[];
}

/**
 * Groups the shown messages into turns (a user message and what the agent did after it). Each tool
 * call joins the latest turn that started before it; text still streaming joins the last turn.
 */
export function buildTurns(messages: Message[], calls: ToolCall[], streaming: Record<string, string>, complete: boolean): Turn[] {
  const turns: Turn[] = [];
  for (const m of messages) {
    if (m.role === 'user' || turns.length === 0) {
      turns.push({ key: m.id, start: m.createdAt, user: m.role === 'user' ? m : null, replies: [], calls: [] });
      if (m.role === 'user') continue;
    }
    turns[turns.length - 1]!.replies.push({ id: m.id, text: m.text, createdAt: m.createdAt, ...(m.effort ? { effort: m.effort } : {}), ...(m.suggestions ? { suggestions: m.suggestions } : {}), ...(m.provider ? { provider: m.provider } : {}) });
  }
  const live = Object.entries(streaming);
  if (turns.length === 0 && (calls.length > 0 || live.length > 0)) turns.push({ key: 'start', start: '', user: null, replies: [], calls: [] });
  for (const c of calls) {
    let i = turns.length - 1;
    while (i > 0 && turns[i]!.start > c.createdAt) i--;
    // Steps from before the first shown message belong to messages that are not shown yet.
    if (i === 0 && !complete && turns[0]!.start > c.createdAt) continue;
    turns[i]?.calls.push(c);
  }
  const last = turns[turns.length - 1];
  for (const [id, text] of live) last?.replies.push({ id, text, createdAt: null });
  return turns;
}

function WorkGroup({ calls, working, cwd }: { calls: ToolCall[]; working: boolean; cwd: string }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const isOpen = open ?? working;
  const current = working ? [...calls].reverse().find((c) => c.status === 'running') ?? null : null;
  const n = calls.length;
  return (
    <div className="work">
      <button className="work-head" type="button" aria-expanded={isOpen} onClick={() => setOpen(!isOpen)}>
        {working ? <StatusIcon state="running" /> : <Icon name="check" size="sm" />}
        <span className="grow">{working ? 'Working' : 'Worked'} · {n} step{n === 1 ? '' : 's'}</span>
        <span className="more-toggle" aria-hidden="true" aria-expanded={isOpen}>
          <span className="lbl">{isOpen ? 'Show less' : 'Show more'}</span><Icon name="chevron-down" size="sm" />
        </span>
      </button>
      <div className={`collapsible${isOpen ? '' : ' closed'}`} inert={!isOpen}>
        <div>
          <ol className="steps">
            {calls.map((c) => {
              const cls = c === current ? 'current' : c.status === 'failed' ? 'failed' : 'done';
              return (
                <li key={c.id} className={cls}>
                  <Icon name={cls === 'current' ? toolIcon(c.name) : cls === 'failed' ? 'x' : 'check'} size="sm" />
                  <span title={c.summary}>{inFolder(c.summary, cwd) || c.name}</span>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </div>
  );
}

const selectThread = (id: string) => (s: AppState) => ({
  messages: s.messages[id] ?? EMPTY_MESSAGES,
  calls: s.toolCalls[id] ?? EMPTY_CALLS,
  requests: s.requests[id] ?? EMPTY_REQUESTS,
  streaming: s.streaming[id] ?? EMPTY_STREAMING,
  loaded: s.loadedChats[id] === true,
  now: s.now,
});

function lastAssistant(messages: Message[]): Message | null {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === 'assistant') return messages[i]!;
  return null;
}

/** "Quick" or "Thorough" when the turn's reply ran at an effort other than Normal. */
function effortNote(replies: { effort?: Message['effort'] }[]): string | null {
  const e = replies.find((r) => r.effort && r.effort !== 'normal')?.effort;
  return e ? EFFORT_LABEL[e] : null;
}

/** One board chat's thread: the latest messages, a "Worked · N steps" group per turn, streaming text and open requests. */
export function Thread({ chat, onSuggest }: { chat: Chat; onSuggest?: (text: string) => void }) {
  const { messages, calls, requests, streaming, loaded, now } = useStore(selectThread(chat.id));
  const [limit, setLimit] = useState(THREAD_PAGE);
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const keepFromBottom = useRef<number | null>(null);

  const hidden = Math.max(0, messages.length - limit);
  const shown = hidden > 0 ? messages.slice(hidden) : messages;
  const turns = buildTurns(shown, calls, streaming, hidden === 0);
  const running = chat.column === 'running';

  // Only when the content changes, so other renders don't force a layout.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (keepFromBottom.current !== null) {
      el.scrollTop = el.scrollHeight - keepFromBottom.current;
      keepFromBottom.current = null;
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, streaming, calls, loaded, limit, requests]);

  // Screen readers hear each agent reply once it is complete, not every streamed piece of it.
  const lastReply = lastAssistant(messages);
  const seen = useRef<string | null | undefined>(undefined);
  const [announce, setAnnounce] = useState('');
  useEffect(() => {
    if (!loaded) return;
    const id = lastReply?.id ?? null;
    if (seen.current === undefined) {
      seen.current = id; // what was already there when the chat opened is not announced
      return;
    }
    if (id === seen.current || !lastReply) return;
    seen.current = id;
    setAnnounce(lastReply.text);
  }, [loaded, lastReply]);

  const showEarlier = () => {
    const el = ref.current;
    if (el) keepFromBottom.current = el.scrollHeight - el.scrollTop;
    setLimit((l) => l + THREAD_PAGE);
  };

  const app = providerName(chat.provider);
  return (
    <div className="thread" ref={ref} role="log" aria-live="off" aria-label="Messages" aria-busy={!loaded}
      onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX; }}>
      <div className="sr-only" role="status" aria-live="polite">{announce}</div>
      {hidden > 0 && (
        <button className="link-btn show-earlier" type="button" onClick={showEarlier}>
          Show earlier ({hidden} more)
        </button>
      )}
      {!loaded && messages.length === 0 && <div className="thread-note">Loading the chat…</div>}
      {turns.map((t, i) => {
        const last = i === turns.length - 1;
        const working = last && running;
        const hasAgent = t.replies.length > 0 || t.calls.length > 0 || working;
        return (
          <div className="turn" key={t.key}>
            {t.user && (
              <div className="msg user">
                <div className="msg-text">{t.user.text}</div>
                <time className="msg-time" dateTime={t.user.createdAt}>{clockTime(t.user.createdAt, now)}</time>
              </div>
            )}
            {hasAgent && (
              <div className="msg agent">
                <div className="who">
                  <ProviderLogo id={t.replies[0]?.provider ?? chat.provider} size="sm" />{t.replies[0]?.provider ? providerName(t.replies[0].provider) : app}
                  {t.replies[0]?.createdAt && <time className="msg-time" dateTime={t.replies[0].createdAt}>{clockTime(t.replies[0].createdAt, now)}</time>}
                </div>
                {t.calls.length > 0 && <WorkGroup calls={t.calls} working={working} cwd={chat.cwd} />}
                {working && t.calls.length === 0 && t.replies.length === 0 && <div className="thread-note"><StatusIcon state="running" />Working…</div>}
                {t.replies.map((r) => <div className="msg-text md" key={r.id}><Markdown text={r.text} /></div>)}
                {effortNote(t.replies) && <div className="effort-note">{effortNote(t.replies)} effort</div>}
              </div>
            )}
          </div>
        );
      })}
      {onSuggest && chat.column !== 'running' && lastReply && messages.at(-1) === lastReply && (lastReply.suggestions?.length ?? 0) > 0 && (
        <div className="suggestions" role="group" aria-label="Suggested next steps">
          {lastReply.suggestions!.map((s, i) => <button className="chip-btn" type="button" key={i} onClick={() => onSuggest(s)}>{s}</button>)}
        </div>
      )}
      {chat.column === 'needs_you' && requests.map((r) => <RequestCard key={r.requestId} chatId={chat.id} provider={chat.provider} cwd={chat.cwd} request={r} />)}
      {chat.column === 'needs_you' && chat.needsReason === 'stopped' && (
        <div className="thread-note"><Icon name="stop" size="sm" />You stopped the agent. Resume to let it carry on, or send a new instruction.</div>
      )}
    </div>
  );
}
