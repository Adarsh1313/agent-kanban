import type { ProviderId } from '@agent-kanban/shared';
import type { HistoryRef } from '../state/reducer.ts';

export type { HistoryRef };

/**
 * Actions that later tasks implement (New chat dialog, row menus, history import). The shell calls
 * these; until a handler is registered they do nothing.
 */
/**
 * `cwd`: the folder to start in; an empty string opens on "Choose another folder" with an empty path.
 * `provider`: preselected when it is allowed for that folder.
 */
export interface NewChatOptions { cwd?: string; provider?: ProviderId }
export interface RowMenuTarget { chatId: string | null; history: HistoryRef | null }

let newChat: ((opts?: NewChatOptions) => void) | null = null;
let rowMenu: ((target: RowMenuTarget, anchor: HTMLElement) => void) | null = null;
let openHistory: ((ref: HistoryRef) => void) | null = null;

export const setNewChatHandler = (h: typeof newChat) => { newChat = h; };
export const setRowMenuHandler = (h: typeof rowMenu) => { rowMenu = h; };
export const setHistoryHandler = (h: typeof openHistory) => { openHistory = h; };

export const openNewChat = (opts?: NewChatOptions) => newChat?.(opts);
export const openRowMenu = (target: RowMenuTarget, anchor: HTMLElement) => rowMenu?.(target, anchor);
export const openHistoryChat = (ref: HistoryRef) => openHistory?.(ref);

let filterMenu: (() => void) | null = null;
export const setFilterHandler = (h: typeof filterMenu) => { filterMenu = h; };
/** Opens the Filter menu (F); does nothing where there is no Filter button. */
export const openFilter = () => filterMenu?.();
