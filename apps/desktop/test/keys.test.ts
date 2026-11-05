import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiKey } from '@agent-kanban/shared';
import { KeyFile, type Cipher } from '../src/keys.ts';

// Stands in for safeStorage: a reversible scramble, so the file can't contain the key as written.
const cipher = (available = true): Cipher => ({
  available: () => available,
  encrypt: (s) => Buffer.from([...Buffer.from(s, 'utf8')].map((b) => b ^ 0x5a)),
  decrypt: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString('utf8'),
});
const SECRET = 'sk-ant-api03-very-secret-value-1a2b';

function setup(c = cipher()) {
  const path = join(mkdtempSync(join(tmpdir(), 'ak-keys-')), 'keys.json');
  return { path, file: new KeyFile({ path, cipher: c, now: () => new Date(2026, 10, 5) }) };
}

test('the stored file never contains the key, only its cipher and last 4', () => {
  const { path, file } = setup();
  const r = file.handle({ op: 'add', provider: 'claude', name: 'Personal', key: SECRET });
  assert.equal(r.ok, true);
  const raw = readFileSync(path, 'utf8');
  assert.equal(raw.includes(SECRET), false);
  assert.equal(raw.includes('very-secret'), false);
  const added = (r as { result: ApiKey }).result;
  assert.deepEqual({ name: added.name, last4: added.last4, capUsd: added.capUsd, spentUsd: added.spentUsd, month: added.month }, { name: 'Personal', last4: '1a2b', capUsd: null, spentUsd: 0, month: '2026-11' });
  assert.equal(JSON.stringify(added).includes(SECRET), false);
});

test('list returns metadata only; reveal decrypts', () => {
  const { file } = setup();
  const added = (file.handle({ op: 'add', provider: 'codex', name: 'Work', key: SECRET }) as { result: ApiKey }).result;
  const list = file.handle({ op: 'list' });
  assert.equal(JSON.stringify(list).includes(SECRET), false);
  assert.equal(JSON.stringify(list).includes('cipher'), false);
  assert.deepEqual(file.handle({ op: 'reveal', id: added.id }), { ok: true, result: SECRET });
});

test('update changes name, cap and spend; remove deletes', () => {
  const { file } = setup();
  const added = (file.handle({ op: 'add', provider: 'claude', name: 'A', key: SECRET }) as { result: ApiKey }).result;
  const u = file.handle({ op: 'update', id: added.id, patch: { name: ' B ', capUsd: 10, spentUsd: 3.2 } }) as { result: ApiKey };
  assert.deepEqual({ name: u.result.name, capUsd: u.result.capUsd, spentUsd: u.result.spentUsd }, { name: 'B', capUsd: 10, spentUsd: 3.2 });
  assert.deepEqual(file.handle({ op: 'update', id: 'nope', patch: {} }), { ok: true, result: null });
  assert.deepEqual(file.handle({ op: 'remove', id: added.id }), { ok: true, result: true });
  assert.deepEqual(file.handle({ op: 'list' }), { ok: true, result: [] });
});

test('no key store on this computer: nothing is saved, with a plain message', () => {
  const { file } = setup(cipher(false));
  const r = file.handle({ op: 'add', provider: 'claude', name: 'A', key: SECRET });
  assert.equal(r.ok, false);
  assert.equal(JSON.stringify(r).includes(SECRET), false);
  assert.deepEqual(file.handle({ op: 'list' }), { ok: true, result: [] });
});
