import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchStopRequest } from '../src/stop-request.ts';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('a stale stop request from an earlier run is cleared at start and does not stop the server', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'ak-stop-')), 'stop.request');
  writeFileSync(path, '');
  let stops = 0;
  const cancel = watchStopRequest(path, () => { stops++; }, 10);
  await wait(50);
  cancel();
  assert.equal(stops, 0);
  assert.equal(existsSync(path), false);
});

test('a stop request runs onStop once and removes the file', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'ak-stop-')), 'stop.request');
  let stops = 0;
  const cancel = watchStopRequest(path, () => { stops++; }, 10);
  writeFileSync(path, '');
  await wait(60);
  writeFileSync(path, '');
  await wait(60);
  cancel();
  assert.equal(stops, 1);
});
