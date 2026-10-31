/**
 * One folder, however a chat spelled it: no trailing separator; a Windows path (drive letter or UNC) uses
 * backslashes and compares case-insensitively. Any other path is kept as is (case-sensitive).
 * Decided by the path's shape, not the platform, so the server and the browser agree.
 * The server groups projects and the web app groups, filters and links them with this same key.
 */
export function folderKey(path: string): string {
  const raw = path.trim();
  const t = raw.replace(/[\\/]+$/, '') || raw;
  return /^[a-z]:/i.test(t) || t.startsWith('\\\\') ? t.replace(/\//g, '\\').toLowerCase() : t;
}

/** The one project the Claude app's folder-less chats are grouped into. */
export const CLAUDE_SCRATCH_NAME = 'Claude scratch chats';

/**
 * The Claude app's `scratch-workspaces` folder when `path` is one of its scratch chat folders
 * (`…/Claude/scratch-workspaces/<id>/scratch-*`), else null.
 */
export function claudeScratchRoot(path: string): string | null {
  const m = /^(.*[\\/]claude[\\/]scratch-workspaces)[\\/](?:[^\\/]+[\\/])*?scratch-[^\\/]*(?:[\\/]|$)/i.exec(path.trim());
  return m ? m[1]! : null;
}

/** The folder of the project a chat belongs to: its own folder, or the scratch root for Claude scratch chats. */
export const projectFolder = (cwd: string): string => claudeScratchRoot(cwd) ?? cwd;

/** True for the Claude app's scratch-workspaces folder itself (the Claude scratch chats project) or a scratch chat folder in it. */
export const isClaudeScratch = (path: string): boolean =>
  claudeScratchRoot(path) !== null || /[\\/]claude[\\/]scratch-workspaces[\\/]*$/i.test(path.trim());
