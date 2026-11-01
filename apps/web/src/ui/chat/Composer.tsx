import { forwardRef, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Icon } from '../primitives/index.ts';

export interface ComposerProps {
  placeholder: string;
  hint: ReactNode;
  /** Resolves true when the text was sent; on false the text stays so nothing typed is lost. */
  onSend: (text: string) => Promise<boolean>;
  /** Skill names `/` offers (the same for every provider; the server sends each in its provider's form). */
  skills?: string[];
  /** Controls shown in the row beside the hint (e.g. the provider and effort pickers). */
  tools?: ReactNode;
  /** Replaces the text and focuses the box when it changes (a suggested next step was picked). */
  fill?: { text: string; n: number } | null;
}

/** Enter sends, Shift+Enter starts a new line. A leading `/` lists skills: arrows move, Enter or Tab picks, Escape closes. */
export const Composer = forwardRef<HTMLTextAreaElement, ComposerProps>(function Composer({ placeholder, hint, onSend, skills = [], tools, fill }, ref) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const listId = useId();
  const box = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (!fill) return;
    setText(fill.text);
    box.current?.focus();
  }, [fill]);
  const setRef = (el: HTMLTextAreaElement | null) => {
    box.current = el;
    if (typeof ref === 'function') ref(el);
    else if (ref) ref.current = el;
  };

  const query = /^\/([\w.:-]*)$/.exec(text)?.[1];
  const matches = query === undefined || dismissed === text ? [] : skills.filter((n) => n.toLowerCase().startsWith(query.toLowerCase()));
  const open = matches.length > 0;
  const at = Math.min(active, matches.length - 1);

  const pick = (name: string) => { setText(`/${name} `); setActive(0); };
  const send = async () => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    const ok = await onSend(value);
    setSending(false);
    if (ok) setText((cur) => (cur.trim() === value ? '' : cur));
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((at + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length);
        return;
      }
      if (((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') && matches[at] !== query) { e.preventDefault(); pick(matches[at]!); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setDismissed(text); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="composer">
      <div className="composer-box">
        {open && (
          <ul className="skill-menu" id={listId} role="listbox" aria-label="Skills">
            {matches.map((n, i) => (
              <li key={n} id={`${listId}-${i}`} role="option" aria-selected={i === at} onMouseDown={(e) => { e.preventDefault(); pick(n); }}>/{n}</li>
            ))}
          </ul>
        )}
        <textarea ref={setRef} placeholder={placeholder} aria-label="Message" value={text}
          aria-autocomplete={skills.length ? 'list' : undefined} aria-controls={open ? listId : undefined}
          aria-activedescendant={open ? `${listId}-${at}` : undefined}
          onChange={(e) => { setText(e.target.value); setActive(0); }} onKeyDown={onKey} />
        <div className="composer-row">
          {tools}
          <span className="grow">{hint}</span>
          <button className="btn primary icon-only" type="button" aria-label="Send" disabled={sending || !text.trim()} onClick={() => void send()}>
            <Icon name="send" />
          </button>
        </div>
      </div>
    </div>
  );
});
