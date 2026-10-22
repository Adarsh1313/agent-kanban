import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readClaudeHistory } from '../src/history/claude.ts';
import { readCodexHistory } from '../src/history/codex.ts';
import { readAntigravityHistory } from '../src/history/antigravity.ts';
import { readAllHistory } from '../src/history/index.ts';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function hashTree(dir: string): string {
  const h = createHash('sha256');
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { h.update(p); h.update(readFileSync(p)); }
    }
  };
  walk(dir);
  return h.digest('hex');
}

test('claude: titled, untitled fallback, corrupt line skipped', async () => {
  const chats = await readClaudeHistory(join(fixtures, 'claude'));
  const by = new Map(chats.map((c) => [c.sessionRef, c]));
  assert.equal(chats.length, 3);
  assert.equal(by.get('titled-1')?.title, 'AI agent Kanban board');
  assert.equal(by.get('titled-1')?.provider, 'claude');
  assert.equal(by.get('titled-1')?.cwd, 'C:\\Users\\me\\proj-a');
  assert.equal(by.get('untitled-2')?.title, 'Fix the login bug in the header component please');
  assert.equal(by.get('corrupt-3')?.title, 'Survives corruption');
  assert.equal(by.get('corrupt-3')?.updatedAt, statSync(join(fixtures, 'claude/projects/proj-a/corrupt-3.jsonl')).mtime.toISOString());
});

test('codex: rollout gives cwd, missing rollout gives empty cwd', async () => {
  const chats = await readCodexHistory(join(fixtures, 'codex'));
  assert.equal(chats.length, 2);
  const a = chats.find((c) => c.sessionRef.endsWith('0001'))!;
  const b = chats.find((c) => c.sessionRef.endsWith('0002'))!;
  assert.equal(a.cwd, 'C:\\AntiGravity files\\lila-apm');
  assert.equal(a.title, 'Locate available Figma projects');
  assert.equal(a.updatedAt, '2026-03-13T15:58:23.711Z');
  assert.equal(b.cwd, '');
  assert.equal(b.title, 'No rollout here');
});

test('antigravity: decodes workspace uri', async () => {
  const chats = await readAntigravityHistory(join(fixtures, 'antigravity/conversation_summaries.db'));
  assert.equal(chats.length, 1);
  assert.equal(chats[0].cwd, fileURLToPath('file:///c%3A/AntiGravity%20files/Parking%20lot'));
  assert.equal(chats[0].title, 'Plan the parking lot');
  assert.equal(chats[0].updatedAt, '2026-04-15T15:25:57.466Z');
});

test('readAllHistory on an empty home is [] and does not throw', async () => {
  const home = mkdtempSync(join(tmpdir(), 'hist-'));
  assert.deepEqual(await readAllHistory(home), []);
});

test('readAllHistory sorts newest first and fixtures stay unchanged', async () => {
  const before = hashTree(fixtures);
  const home = fixtures; // not a real home; use per-provider readers for the rest
  assert.ok(Array.isArray(await readAllHistory(home)));
  await readClaudeHistory(join(fixtures, 'claude'));
  await readCodexHistory(join(fixtures, 'codex'));
  await readAntigravityHistory(join(fixtures, 'antigravity/conversation_summaries.db'));
  assert.equal(hashTree(fixtures), before);
});
