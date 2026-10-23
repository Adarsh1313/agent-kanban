import type { HistoryRef } from '../state/reducer.ts';

export type { HistoryRef };

/**
 * Actions that later tasks implement (New chat dialog, row menus, history import). The shell calls
 * these; until a handler is registered they do nothing.
 */
export interface NewChatOptions { cwd?: string }
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
