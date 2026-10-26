import type { ToolCall } from '@agent-kanban/shared';
import { useState } from 'react';
import { Icon, SwapText, type IconName } from '../primitives/index.ts';
import { currentCall, toolIcon } from './format.ts';

const SHOWN_STEPS = 5;
const STARTING = 'Getting started…';

const stepIcon = (call: ToolCall, current: boolean): IconName =>
  call.status === 'failed' ? 'x' : current ? toolIcon(call.name) : 'check';

/** A running card's current step, with "Show more" listing the last few steps. `starting` replaces "Getting started…". */
export function ActivityLine({ calls, starting }: { calls: ToolCall[] | undefined; starting?: string }) {
  const [open, setOpen] = useState(false);
  const cur = currentCall(calls);
  const recent = (calls ?? []).slice(-SHOWN_STEPS);
  return (
    <div className="activity">
      <div className="activity-line">
        <Icon name={cur ? toolIcon(cur.name) : 'clock'} size="sm" />
        <SwapText text={cur?.summary || starting || STARTING} className="now" title />
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
