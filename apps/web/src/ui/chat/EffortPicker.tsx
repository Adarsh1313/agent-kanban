import { EFFORTS, PROVIDER_CAPABILITIES, type Chat, type Effort } from '@agent-kanban/shared';
import { useRef, useState } from 'react';
import { api } from '../../api/client.ts';
import { useStoreInstance } from '../../state/store.ts';
import { Icon } from '../primitives/index.ts';
import { Menu, MenuItem } from '../primitives/Menu.tsx';
import { runAction } from './ChatActionsMenu.tsx';

export const EFFORT_LABEL: Record<Effort, string> = { quick: 'Quick', normal: 'Normal', thorough: 'Thorough' };
const EFFORT_HINT: Record<Effort, string> = {
  quick: 'Answers fast, for small asks',
  normal: 'The usual balance',
  thorough: 'Takes extra time on hard problems',
};

/** The composer's effort menu: sticky per chat, applies from the next message. Hidden when the provider has no such setting. */
export function EffortPicker({ chat }: { chat: Chat }) {
  const store = useStoreInstance();
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if (!PROVIDER_CAPABILITIES[chat.provider].effort) return null;
  const effort = chat.effort ?? 'normal';
  const pick = (e: Effort) => {
    setOpen(false);
    if (e !== effort) void runAction(store, () => api.patchChat(chat.id, { effort: e }));
  };
  return (
    <>
      <button ref={btn} className="btn ghost effort-btn" type="button" aria-haspopup="menu" aria-expanded={open}
        aria-label={`Effort: ${EFFORT_LABEL[effort]}`} onClick={() => setOpen((o) => !o)}>
        {EFFORT_LABEL[effort]}<Icon name="chevron-down" size="sm" />
      </button>
      <Menu anchor={btn.current} open={open} onClose={() => setOpen(false)} label="Effort" panes={{
        root: () => EFFORTS.map((e) => (
          <MenuItem key={e} checked={e === effort} onSelect={() => pick(e)}>
            <span className="effort-item">{EFFORT_LABEL[e]}<small>{EFFORT_HINT[e]}</small></span>
          </MenuItem>
        )),
      }} />
    </>
  );
}
