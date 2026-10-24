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
