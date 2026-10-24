import { readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where the built web app lives, relative to this file (apps/server/src → apps/web/dist). */
export const DEFAULT_DIST = fileURLToPath(new URL('../../web/dist/', import.meta.url));

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2', '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon', '.html': 'text/html; charset=utf-8',
};

/** The absolute file for a URL path inside `dist`, or null when it escapes `dist` or isn't a file. */
export function staticFile(dist: string, pathname: string): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.includes('\0')) return null;
  const root = resolve(dist);
  const file = resolve(root, '.' + (decoded.startsWith('/') ? decoded : '/' + decoded));
  if (!file.startsWith(root + sep)) return null;
  try { return statSync(file).isFile() ? file : null; } catch { return null; }
}

export function readStatic(file: string): { body: Buffer; type: string } {
  return { body: readFileSync(file), type: TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream' };
}

export function shellFile(dist: string): string | null {
  return staticFile(dist, '/index.html');
}
