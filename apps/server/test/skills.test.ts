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

// ---- HTTP API ----

test('GET /api/skills reports synced and skipped skills; picking a home provider syncs; POST /api/skills/sync reruns', async () => {
  const { Store } = await import('../src/store.ts');
  const { SettingsStore } = await import('../src/settings.ts');
  const { SkillService } = await import('../src/skills/service.ts');
  const { createApi } = await import('../src/api.ts');
  const home = tempHome();
  skill(join(home, '.claude', 'skills'), 'grill');
  skill(join(home, '.codex', 'skills'), 'grill', 'mine');
  const settings = new SettingsStore(new Store(join(home, 'ak.db')));
  const skills = new SkillService({ home, settings: () => settings.get() });
  const api = createApi({ chats: { listChats: () => [] } as any, usage: { latest: () => [] } as any, history: async () => [], token: 'tok', settings, skills });
  await new Promise<void>((r) => api.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(api.server.address() as import('node:net').AddressInfo).port}`;
  const f = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' } }).then((r) => r.json());
  try {
    assert.deepEqual(await f('/api/skills'), { synced: [], skipped: [], available: [] });
    await f('/api/settings', { method: 'PATCH', body: JSON.stringify({ homeProvider: 'claude' }) });
    assert.deepEqual(await f('/api/skills'), { synced: ['grill'], skipped: [{ name: 'grill', provider: 'codex' }], available: ['grill'] });
    skill(join(home, '.claude', 'skills'), 'tdd');
    assert.deepEqual((await f('/api/skills/sync', { method: 'POST' })).synced, ['grill', 'tdd']);
    assert.ok(existsSync(join(home, '.gemini', 'antigravity', 'skills', 'tdd', MARKER)));
  } finally {
    skills.stop(); api.close(); api.server.closeAllConnections(); api.server.close();
  }
});

test('a picked skill reaches each provider in its own form', async () => {
  const { skillForm } = await import('../src/skills/form.ts');
  const names = ['grill'];
  assert.equal(skillForm('claude', '/grill the plan', names), '/grill the plan');
  assert.equal(skillForm('codex', '/grill the plan', names), '$grill the plan');
  assert.match(skillForm('antigravity', '/grill the plan', names), /^Run the "grill" workflow from your skills\.\n\nthe plan$/);
  assert.equal(skillForm('codex', '/other x', names), '/other x');
  assert.equal(skillForm('codex', 'see /grill', names), 'see /grill');
});
