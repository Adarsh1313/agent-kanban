import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const start = (tag: string) => (tag ? `<!-- managed by Agent Kanban: ${tag} -->` : '<!-- managed by Agent Kanban -->');
const END = '<!-- end -->';

/**
 * `text` with its fenced managed block set to `content`, or removed when `content` is null. The user's own text
 * around the block is kept; a new block goes at the end.
 */
export function withBlock(text: string, content: string | null, tag = ''): string {
  const open = start(tag);
  const i = text.indexOf(open);
  const j = i < 0 ? -1 : text.indexOf(END, i + open.length);
  let before = text.replace(/\s+$/, '');
  let after = '';
  if (i >= 0 && j >= 0) {
    before = text.slice(0, i).replace(/\s+$/, '');
    after = text.slice(j + END.length).replace(/^\s+|\s+$/g, '');
  }
  const parts = [before, content === null ? '' : `${open}\n${content.trim()}\n${END}`, after].filter(Boolean);
  return parts.length ? parts.join('\n\n') + '\n' : '';
}

/** Writes the managed block into a file (creating it when there's something to write); true if the file changed. */
export function writeBlock(path: string, content: string | null, tag = ''): boolean {
  const had = existsSync(path);
  if (!had && content === null) return false;
  const old = had ? readFileSync(path, 'utf8') : '';
  if (content === null && !old.includes(start(tag))) return false;
  const next = withBlock(old, content, tag);
  if (next === old) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next);
  return true;
}
