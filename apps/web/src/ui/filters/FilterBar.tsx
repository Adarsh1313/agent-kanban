import { Fragment } from 'react';
import type { AppState } from '../../state/reducer.ts';
import { memoState } from '../../state/selectors.ts';
import { useStore, useStoreInstance } from '../../state/store.ts';
import { Icon, ProviderLogo, StatusIcon } from '../primitives/index.ts';
import { activeKeys, CATEGORIES, chipParts, clearAllFilters, filtersIn, setFilter, type FilterKey, type FilterOption, type FilterScope } from './model.ts';

/** The logo or status icon drawn before an option's label (design: o.html). */
export function OptionVisual({ o }: { o: FilterOption }) {
  if (o.provider) return <ProviderLogo id={o.provider} size="sm" />;
  if (o.status) return <StatusIcon state={o.status} />;
  return null;
}

interface Chip { key: FilterKey; op: string; values: FilterOption[]; text: string | null }

const chipSelector = (scope: FilterScope) => memoState((s: AppState) => [filtersIn(s, scope), s.chats, s.history, s.projects], (s): Chip[] =>
  activeKeys(filtersIn(s, scope)).map((key) => ({ key, ...chipParts(s, key, scope) })));
const SELECT_CHIPS: Record<FilterScope, (s: AppState) => Chip[]> = { board: chipSelector('board'), chats: chipSelector('chats') };

/** Active filters as chips under the top bar ("Provider is any of …" with ×), and Clear all. */
export function FilterBar({ scope = 'board' }: { scope?: FilterScope }) {
  const store = useStoreInstance();
  const chips = useStore(SELECT_CHIPS[scope]);
  if (chips.length === 0) return null;
  return (
    <div className="filterbar" role="group" aria-label="Active filters">
      {chips.map(({ key, op, values, text }) => {
        const cat = CATEGORIES[key];
        return (
          <span className="fchip" key={key}>
            <span className="k"><Icon name={cat.icon} size="sm" />{cat.label}</span>
            <span className="op">{op}</span>
            <span className="v">
              {text === null
                ? values.map((o, i) => <Fragment key={o.v}>{i > 0 && ', '}<OptionVisual o={o} />{o.label}</Fragment>)
                : <>{values.map((o) => <OptionVisual key={o.v} o={o} />)}{text}</>}
            </span>
            <button type="button" aria-label={`Remove ${cat.label} filter`} onClick={() => store.setState((s) => setFilter(s, key, null, scope))}>
              <Icon name="x" size="sm" />
            </button>
          </span>
        );
      })}
      <button className="link-btn" type="button" onClick={() => store.setState((s) => clearAllFilters(s, scope))}>Clear all</button>
    </div>
  );
}
