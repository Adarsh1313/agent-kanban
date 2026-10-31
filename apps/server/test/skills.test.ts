import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncSkills, MARKER } from '../src/skills/sync.ts';
import { withBlock } from '../src/skills/managed.ts';

const tempHome = () => mkdtempSync(join(tmpdir(), 'ak-skills-'));
const skill = (dir: string, name: string, body = `# ${name}`) => {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'SKILL.md'), body);
};

test('copies and marks home skills (plugin skills included) into the other providers', () => {
  const home = tempHome();
  skill(join(home, '.claude', 'skills'), 'grill');
  skill(join(home, '.claude', 'plugins', 'cache', 'mkt', 'plug', '1.0.0', 'skills'), 'tdd');
  const r = syncSkills(home, 'claude');
  assert.deepEqual(r, { synced: ['grill', 'tdd'], skipped: [] });
  for (const dir of [join(home, '.codex', 'skills'), join(home, '.gemini', 'antigravity', 'skills')]) {
    assert.equal(readFileSync(join(dir, 'grill', 'SKILL.md'), 'utf8'), '# grill');
    assert.ok(existsSync(join(dir, 'tdd', MARKER)));
  }
  assert.ok(!existsSync(join(home, '.claude', 'skills', 'grill', MARKER)));
});

test('updates a copy when its source changes and removes it when the source is gone', () => {
  const home = tempHome();
  const src = join(home, '.claude', 'skills');
  skill(src, 'grill');
  skill(src, 'old');
  syncSkills(home, 'claude');
  writeFileSync(join(src, 'grill', 'SKILL.md'), '# grill v2');
  rmSync(join(src, 'old'), { recursive: true });
  const r = syncSkills(home, 'claude');
  assert.deepEqual(r.synced, ['grill']);
  assert.equal(readFileSync(join(home, '.codex', 'skills', 'grill', 'SKILL.md'), 'utf8'), '# grill v2');
  assert.ok(!existsSync(join(home, '.codex', 'skills', 'old')));
});

test("leaves the user's own same-named skill alone and reports it as skipped", () => {
  const home = tempHome();
  skill(join(home, '.claude', 'skills'), 'grill');
  skill(join(home, '.codex', 'skills'), 'grill', 'mine');
  skill(join(home, '.codex', 'skills'), 'own', 'mine');
  const r = syncSkills(home, 'claude');
  assert.deepEqual(r.skipped, [{ name: 'grill', provider: 'codex' }]);
  assert.deepEqual(r.synced, ['grill']); // it reached Antigravity
  assert.equal(readFileSync(join(home, '.codex', 'skills', 'grill', 'SKILL.md'), 'utf8'), 'mine');
  assert.ok(existsSync(join(home, '.codex', 'skills', 'own', 'SKILL.md')));
});

test("global instructions go into a managed block; the user's own text survives", () => {
  const home = tempHome();
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'Lead with the answer.');
  writeFileSync(join(home, '.codex', 'AGENTS.md'), 'My codex rules.\n');
  syncSkills(home, 'claude');
  writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'Be brief.');
  syncSkills(home, 'claude');
  const agents = readFileSync(join(home, '.codex', 'AGENTS.md'), 'utf8');
  assert.equal(agents, 'My codex rules.\n\n<!-- managed by Agent Kanban -->\nBe brief.\n<!-- end -->\n');
  assert.match(readFileSync(join(home, '.gemini', 'GEMINI.md'), 'utf8'), /Be brief\./);
});

test('withBlock removes only the block', () => {
  const t = withBlock('top\n\nbottom-less', 'x');
  assert.equal(withBlock(t, null), 'top\n\nbottom-less\n');
  assert.equal(withBlock('a\n' + withBlock('', 'x') + '\nb', null), 'a\n\nb\n');
});
