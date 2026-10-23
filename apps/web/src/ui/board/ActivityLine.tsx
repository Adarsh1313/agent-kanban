import type { ToolCall } from '@agent-kanban/shared';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon, type IconName } from '../primitives/index.ts';
import { cssMs, reducedMotion } from '../primitives/motion.ts';
import { currentCall, toolIcon } from './format.ts';

const SHOWN_STEPS = 5;
const STARTING = 'Getting started…';

/**
 * Crossfades a line of text through a short blur when it changes (design swapText, --duration-swap):
 * "out" blurs the old text away, then the new text starts from "in" and transitions to rest.
 * With reduced motion the text is replaced at once.
 */
function SwapText({ text }: { text: string }) {
  const [shown, setShown] = useState(text);
  const [phase, setPhase] = useState<'' | 'out' | 'in'>('');
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (text === shown) {
      setPhase((p) => (p === 'out' ? '' : p));
      return;
    }
    if (reducedMotion()) {
      setShown(text);
      setPhase('');
      return;
    }
    setPhase('out');
    const t = setTimeout(() => {
      setShown(text);
      setPhase('in');
    }, cssMs('--duration-swap', 200));
    return () => clearTimeout(t);
    // `shown` is read only to skip a change back to the text already shown.
  }, [text]);
  // Commit the "in" start state, flush styles, then drop it so the entrance transitions.
  useLayoutEffect(() => {
    if (phase !== 'in') return;
    void ref.current?.offsetWidth;
    setPhase('');
  }, [phase]);
  return <span className={phase ? `now ${phase}` : 'now'} ref={ref} title={shown}>{shown}</span>;
}

const stepIcon = (call: ToolCall, current: boolean): IconName =>
  call.status === 'failed' ? 'x' : current ? toolIcon(call.name) : 'check';

/** A running card's current step, with "Show more" listing the last few steps. */
export function ActivityLine({ calls }: { calls: ToolCall[] | undefined }) {
  const [open, setOpen] = useState(false);
  const cur = currentCall(calls);
  const recent = (calls ?? []).slice(-SHOWN_STEPS);
  return (
    <div className="activity">
      <div className="activity-line">
        <Icon name={cur ? toolIcon(cur.name) : 'clock'} size="sm" />
        <SwapText text={cur?.summary || STARTING} />
        {recent.length > 0 && (
          <button className="more-toggle" type="button" aria-expanded={open}
            onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}>
            <span className="lbl">{open ? 'Show less' : 'Show more'}</span><Icon name="chevron-down" size="sm" />
          </button>
        )}
      </div>
      <div className="sweep" aria-hidden="true" />
      {recent.length > 0 && (
        <div className={`collapsible${open ? '' : ' closed'}`} inert={!open}>
          <div>
            <ol className="steps">
              {recent.map((c) => {
                const isCur = c === cur;
                return (
                  <li key={c.id} className={isCur ? 'current' : 'done'}>
                    <Icon name={stepIcon(c, isCur)} size="sm" /><span title={c.summary}>{c.summary}</span>
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
      )}
    </div>
  );
}
