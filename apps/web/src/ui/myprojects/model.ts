import type { Project } from '@agent-kanban/shared';
import { folderKey, isClaudeScratch, projectFolder } from '@agent-kanban/shared';
import { api } from '../../api/client.ts';
import { applySettings } from '../../state/reducer.ts';
import { OLDER_MS } from '../../state/selectors.ts';
import type { Store } from '../../state/store.ts';
import { errorText } from '../board/Card.tsx';
import { toast } from '../primitives/index.ts';

const DAY = 86_400_000;
/** Projects active within this long are pre-ticked when the user first picks, at most PRE_TICK of them. */
export const PRE_TICK_MS = 14 * DAY;
export const PRE_TICK = 5;

const byActivity = (a: Project, b: Project) => (a.lastActivityAt < b.lastActivityAt ? 1 : a.lastActivityAt > b.lastActivityAt ? -1 : 0);

/** The projects the picker offers: not hidden, most recently active first. */
export const pickable = (projects: Project[]): Project[] => projects.filter((p) => !p.hidden).sort(byActivity);

export const isOlderProject = (p: Project, now: number) => now - Date.parse(p.lastActivityAt) > OLDER_MS;

/** First-time picks: up to 5 projects active in the last 14 days, newest first (Claude scratch chats is never pre-ticked). */
export function defaultPicks(projects: Project[], now: number): string[] {
  return pickable(projects)
    .filter((p) => now - Date.parse(p.lastActivityAt) <= PRE_TICK_MS && !isClaudeScratch(p.id))
    .slice(0, PRE_TICK)
    .map((p) => p.id);
}

/** True when this project is one of the user's My projects. */
export const inMine = (mine: string[] | null | undefined, id: string) => (mine ?? []).some((f) => folderKey(f) === folderKey(id));

/**
 * Saves My projects (reading settings first if they haven't loaded, like Hide project). False, with a toast, when it
 * couldn't be saved.
 */
export async function saveMyProjects(store: Store, next: (cur: string[] | null) => string[]): Promise<boolean> {
  try {
    let cur = store.getState().settings;
    if (!cur) {
      cur = await api.settings();
      const loaded = cur;
      store.setState((s) => applySettings(s, loaded));
    }
    const settings = await api.patchSettings({ myProjects: next(cur.myProjects) });
    if (settings) store.setState((s) => applySettings(s, settings));
    return true;
  } catch (e) {
    toast(errorText(e));
    return false;
  }
}

/**
 * After a chat starts here (New chat, or carrying a history chat on): its project joins My projects, unless the user
 * has never picked (then the pick card still asks) or it is already there. Fire and forget.
 */
export function addAfterStart(store: Store, cwd: string): void {
  const mine = store.getState().settings?.myProjects;
  const folder = projectFolder(cwd);
  if (mine === null || mine === undefined || inMine(mine, folder)) return;
  void setInMyProjects(store, folder, true);
}

/** Adds a project to My projects or removes it (the star on Projects, Remove on a card, Add on the hint). */
export const setInMyProjects = (store: Store, path: string, on: boolean) =>
  saveMyProjects(store, (cur) => {
    const rest = (cur ?? []).filter((f) => folderKey(f) !== folderKey(path));
    return on ? [...rest, path] : rest;
  });
