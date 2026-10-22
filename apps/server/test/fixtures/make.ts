// Generates the codex rollout (.zst) and antigravity SQLite fixtures. Run manually: node apps/server/test/fixtures/make.ts
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url));

const rolloutId = '019ce7eb-0000-7000-8000-000000000001';
const rolloutDir = join(here, 'codex', 'sessions', '2026', '03', '13');
mkdirSync(rolloutDir, { recursive: true });
const meta = { type: 'session_meta', payload: { id: rolloutId, cwd: 'C:\\AntiGravity files\\lila-apm' } };
const next = { type: 'event_msg', payload: { text: 'hello' } };
writeFileSync(
  join(rolloutDir, `rollout-2026-03-13T15-58-23-${rolloutId}.jsonl.zst`),
  zstdCompressSync(Buffer.from(JSON.stringify(meta) + '\n' + JSON.stringify(next) + '\n')),
);

const agDir = join(here, 'antigravity');
mkdirSync(agDir, { recursive: true });
const dbPath = join(agDir, 'conversation_summaries.db');
rmSync(dbPath, { force: true });
const db = new DatabaseSync(dbPath);
try {
  db.exec('PRAGMA journal_mode = DELETE');
  db.exec(`CREATE TABLE conversation_summaries (conversation_id text, title text, preview text, step_count integer, last_modified_time datetime, workspace_uris text, status text, source text)`);
  db.prepare('INSERT INTO conversation_summaries VALUES (?,?,?,?,?,?,?,?)').run(
    'ag-conv-1', 'Plan the parking lot', 'preview', 3, '2026-04-15 15:25:57.4668486+00:00',
    '["file:///c%3A/AntiGravity%20files/Parking%20lot"]', 'idle', 'local',
  );
} finally { db.close(); }
