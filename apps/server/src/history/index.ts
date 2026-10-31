import { join } from 'node:path';
import type { HistoryChat } from '@agent-kanban/shared';
import { readClaudeHistory } from './claude.ts';
import { readCodexHistory } from './codex.ts';
import { readAntigravityHistory } from './antigravity.ts';

export { readClaudeHistory, readCodexHistory, readAntigravityHistory };
export { readTranscript, type Transcript } from './transcript.ts';

export async function readAllHistory(home: string): Promise<HistoryChat[]> {
  const parts = await Promise.all([
    readClaudeHistory(join(home, '.claude')).catch(() => []),
    readCodexHistory(join(home, '.codex')).catch(() => []),
    readAntigravityHistory(join(home, '.gemini', 'antigravity', 'conversation_summaries.db')).catch(() => []),
  ]);
  return parts.flat().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
