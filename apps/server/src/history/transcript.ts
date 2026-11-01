import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProviderId } from '@agent-kanban/shared';
import { readJsonl } from './jsonl.ts';
import { findRollout, readRollout } from './codex.ts';

/** A message from a chat that lives only in the provider's own history (#16). Read-only; nothing is ever written. */
export interface TranscriptMessage { role: 'user' | 'assistant'; text: string; at: string | null }
export interface Transcript {
  messages: TranscriptMessage[];
  /** Older messages were left out (only the last `limit` are returned). */
  truncated: boolean;
  /** This provider's history can't be read as messages (Antigravity), or the chat's file wasn't found. */
  unavailable: boolean;
}

export const TRANSCRIPT_LIMIT = 200;
/** Session ids are uuids (Claude, Codex); anything else could name a path, so it is refused. */
const SAFE_REF = /^[0-9A-Za-z][0-9A-Za-z-]{0,99}$/;
/** Context the CLIs add to the user's turn (Codex <environment_context>, Claude <command-name> …), not typed by the user. */
const INJECTED = /^\s*<(?:command-[\w-]+|local-command-[\w-]+|system-reminder|environment_context|user_instructions|permissions|user-prompt-submit-hook|bash-(?:input|stdout|stderr))>/i;
/** Codex also adds these as separate user blocks (seen in real rollouts): instructions and context, not the user's words. */
const CODEX_INJECTED = /^\s*# (?:AGENTS\.md instructions|Files mentioned by the user|In app browser)\b/;

const iso = (v: unknown): string | null => {
  const d = new Date(typeof v === 'string' ? v : NaN);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

function tail(messages: TranscriptMessage[], limit: number): Transcript {
  return { messages: messages.slice(-limit), truncated: messages.length > limit, unavailable: false };
}

const NONE: Transcript = { messages: [], truncated: false, unavailable: true };

export async function readTranscript(home: string, provider: ProviderId, sessionRef: string, limit = TRANSCRIPT_LIMIT): Promise<Transcript> {
  if (!SAFE_REF.test(sessionRef)) return NONE;
  if (provider === 'claude') return readClaude(join(home, '.claude'), sessionRef, limit);
  if (provider === 'codex') return readCodex(join(home, '.codex'), sessionRef, limit);
  return NONE;
}

async function findClaudeFile(claudeHome: string, sessionRef: string): Promise<string | null> {
  const root = join(claudeHome, 'projects');
  let dirs: string[];
  try { dirs = await readdir(root); } catch { return null; }
  for (const d of dirs) {
    try {
      if ((await readdir(join(root, d))).includes(`${sessionRef}.jsonl`)) return join(root, d, `${sessionRef}.jsonl`);
    } catch { /* not a folder */ }
  }
  return null;
}

function userText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content) || content.some((b) => b?.type === 'tool_result')) return '';
  return content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => (b.text as string).trim()).filter(Boolean).join('\n\n');
}

async function readClaude(claudeHome: string, sessionRef: string, limit: number): Promise<Transcript> {
  const path = await findClaudeFile(claudeHome, sessionRef);
  if (!path) return NONE;
  const out: TranscriptMessage[] = [];
  let lastAssistantId: string | null = null;
  for await (const rec of readJsonl(path)) {
    // Subagent turns, meta records and the summary Claude writes when it compacts a long chat are not the user's words.
    if (rec.isSidechain === true || rec.isMeta === true || rec.isCompactSummary === true) continue;
    const msg = rec.message as { id?: unknown; content?: unknown } | undefined;
    if (rec.type === 'user') {
      // What the user typed: a string, or text blocks next to pasted images. Tool results going back are skipped.
      const text = userText(msg?.content);
      if (text && !INJECTED.test(text)) { out.push({ role: 'user', text, at: iso(rec.timestamp) }); lastAssistantId = null; }
    } else if (rec.type === 'assistant' && Array.isArray(msg?.content)) {
      const text = msg.content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text as string).join('\n').trim();
      if (!text) continue;
      const id = typeof msg.id === 'string' ? msg.id : null;
      const prev = out[out.length - 1];
      // One reply can arrive as several records of the same message: they read as one.
      if (prev?.role === 'assistant' && id !== null && id === lastAssistantId) prev.text += '\n\n' + text;
      else out.push({ role: 'assistant', text, at: iso(rec.timestamp) });
      lastAssistantId = id;
    }
  }
  return tail(out, limit);
}

async function readCodex(codexHome: string, sessionRef: string, limit: number): Promise<Transcript> {
  const path = await findRollout(codexHome, sessionRef);
  if (!path) return NONE;
  let text: string;
  try { text = await readRollout(path); } catch { return NONE; }
  const out: TranscriptMessage[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec: any;
    try { rec = JSON.parse(line); } catch { continue; }
    const p = rec?.payload;
    if (rec?.type !== 'response_item' || p?.type !== 'message' || (p.role !== 'user' && p.role !== 'assistant') || !Array.isArray(p.content)) continue;
    const parts = p.content
      .filter((b: any) => (b?.type === 'input_text' || b?.type === 'output_text') && typeof b.text === 'string')
      .map((b: any) => (b.text as string).trim())
      .filter((t: string) => t && !(p.role === 'user' && (INJECTED.test(t) || CODEX_INJECTED.test(t))));
    if (parts.length) out.push({ role: p.role, text: parts.join('\n\n'), at: iso(rec.timestamp) });
  }
  return tail(out, limit);
}
