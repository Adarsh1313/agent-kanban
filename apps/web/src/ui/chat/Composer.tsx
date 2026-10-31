import { forwardRef, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Icon } from '../primitives/index.ts';

export interface ComposerProps {
  placeholder: string;
  hint: string;
  /** Resolves true when the text was sent; on false the text stays so nothing typed is lost. */
  onSend: (text: string) => Promise<boolean>;
  /** Controls shown in the row beside the hint (e.g. the effort picker). */
  tools?: ReactNode;
  /** Replaces the text and focuses the box when it changes (a suggested next step was picked). */
  fill?: { text: string; n: number } | null;
}

/** Enter sends, Shift+Enter starts a new line. */
export const Composer = forwardRef<HTMLTextAreaElement, ComposerProps>(function Composer({ placeholder, hint, onSend, tools, fill }, ref) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
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

  const send = async () => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    const ok = await onSend(value);
    setSending(false);
    if (ok) setText((cur) => (cur.trim() === value ? '' : cur));
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="composer">
      <div className="composer-box">
        <textarea ref={setRef} placeholder={placeholder} aria-label="Message" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} />
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
