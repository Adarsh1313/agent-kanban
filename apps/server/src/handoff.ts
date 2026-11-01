import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Message, ProviderId, ToolCall } from '@agent-kanban/shared';

/** Handoff budget in tokens (estimated at 4 characters a token). One constant so it can be tuned. */
export const HANDOFF_TOKENS = 16_000;
const CHARS_PER_TOKEN = 4;
/** Items that aren't messages (tool calls) are cut to this many characters. */
const ITEM_MAX = 240;

const NAMES: Record<ProviderId, string> = { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' };

/** The active spec (decision 8): the newest docs/specs/*.md with unchecked Progress lines, and those lines. */
export function activeSpec(cwd: string): { path: string; unchecked: string[] } | null {
  const dir = join(cwd, 'docs', 'specs');
  let files: { name: string; at: number }[] = [];
  try {
    files = readdirSync(dir).filter((n) => n.endsWith('.md')).map((name) => ({ name, at: statSync(join(dir, name)).mtimeMs }));
  } catch { return null; }
  files.sort((a, b) => b.at - a.at);
  for (const f of files) {
    let text = '';
    try { text = readFileSync(join(dir, f.name), 'utf8'); } catch { continue; }
    const progress = /^##\s+Progress\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(text)?.[1] ?? '';
    const unchecked = progress.split(/\r?\n/).filter((l) => /^\s*[-*]\s+\[ \]/.test(l)).map((l) => l.trim());
    if (unchecked.length) return { path: `docs/specs/${f.name}`, unchecked };
  }
  return null;
}

/**
 * The preface sent before the first message to a new provider: the recent conversation (newest first until the
 * budget runs out, then shown oldest first), the active spec's unchecked Progress lines and the project notes.
 */
export function buildPreface(input: {
  to: ProviderId;
  messages: Message[];
  toolCalls?: ToolCall[];
  /** Messages the new provider already saw (it took part before): only later ones are sent. */
  since?: number;
  cwd: string;
  notes?: string | null;
}): string {
  const fresh = input.messages.slice(input.since ?? 0);
  const from = fresh[0]?.createdAt;
  const calls = (input.toolCalls ?? []).filter((t) => !from || t.createdAt >= from);
  type Item = { at: string; line: string };
  const items: Item[] = [
    ...fresh.map((m) => ({ at: m.createdAt, line: `${m.role === 'user' ? 'User' : NAMES[m.provider ?? input.to]}: ${m.text}` })),
    ...calls.map((t) => ({ at: t.createdAt, line: `[tool ${t.name}] ${t.summary}`.slice(0, ITEM_MAX) })),
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  let room = HANDOFF_TOKENS * CHARS_PER_TOKEN;
  const kept: string[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const line = items[i]!.line;
    if (line.length > room) break;
    room -= line.length + 1;
    kept.unshift(line);
  }

  const parts: string[] = [
    input.since ? `You are continuing this chat. Here is what happened since you last took part:` : `You are taking over this chat from another coding agent. Here is the conversation so far:`,
    kept.length ? kept.join('\n') : '(nothing new)',
  ];
  const spec = activeSpec(input.cwd);
  if (spec) parts.push(`Active spec: ${spec.path}. Still to do:\n${spec.unchecked.join('\n')}`);
  if (input.notes?.trim()) parts.push(`Project notes (.agent-kanban/notes.md):\n${input.notes.trim()}`);
  parts.push('The user’s new message follows.');
  return parts.join('\n\n');
}
