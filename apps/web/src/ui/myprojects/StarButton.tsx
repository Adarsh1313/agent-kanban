import type { Project } from '@agent-kanban/shared';
import { useStore, useStoreInstance } from '../../state/store.ts';
import { Icon, Tooltip } from '../primitives/index.ts';
import { inMine, setInMyProjects } from './model.ts';

/** Adds the project to My projects or takes it out (the sidebar shows My projects). */
export function StarButton({ project, labelled = false }: { project: Project; labelled?: boolean }) {
  const store = useStoreInstance();
  const on = useStore((s) => inMine(s.settings?.myProjects, project.id));
  const label = on ? `Remove ${project.name} from My projects` : `Add ${project.name} to My projects`;
  const toggle = () => void setInMyProjects(store, project.path, !on);
  if (labelled) {
    return (
      <button className="btn ghost star-btn" type="button" aria-pressed={on} onClick={toggle}>
        <Icon name="star" size="sm" />{on ? 'In My projects' : 'Add to My projects'}
      </button>
    );
  }
  return (
    <Tooltip label={on ? 'Remove from My projects' : 'Add to My projects'}>
      <button className="btn icon-only ghost star-btn row-star" type="button" aria-pressed={on} aria-label={label} onClick={toggle}>
        <Icon name="star" size="sm" />
      </button>
    </Tooltip>
  );
}
