import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeBlock } from './skills/managed.ts';

/** Project notes (#40): one file per project that every agent reads and updates at the end of each task. */
export const NOTES_PATH = '.agent-kanban/notes.md';
const FILES = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'];
const LINE = `Project notes live in ${NOTES_PATH}. Read them before you start, and at the end of each task update them with decisions made and what is left.`;
const TEMPLATE = '# Project notes\n\nDecisions and open questions every agent should know. Agents update this at the end of each task.\n';

export const notesFile = (cwd: string) => join(cwd, ...NOTES_PATH.split('/'));

/** Turns notes on: creates the notes file if missing and adds the managed line to each instruction file. */
export function enableNotes(cwd: string): void {
  const file = notesFile(cwd);
  if (!existsSync(file)) { mkdirSync(join(cwd, '.agent-kanban'), { recursive: true }); writeFileSync(file, TEMPLATE); }
  for (const f of FILES) writeBlock(join(cwd, f), LINE, 'notes');
}

/** Turns notes off: removes the managed lines and keeps the notes file. */
export function disableNotes(cwd: string): void {
  for (const f of FILES) writeBlock(join(cwd, f), null, 'notes');
}

export function readNotes(cwd: string): string | null {
  try { return readFileSync(notesFile(cwd), 'utf8'); } catch { return null; }
}

export function writeNotes(cwd: string, text: string): void {
  mkdirSync(join(cwd, '.agent-kanban'), { recursive: true });
  writeFileSync(notesFile(cwd), text);
}
