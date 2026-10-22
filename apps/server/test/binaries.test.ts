import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickBinary } from '../src/binaries.ts';

test('windows: extensionless shim first, CRLF, .exe preferred over .cmd', () => {
  const out = 'C:\\npm\\codex\r\nC:\\npm\\codex.cmd\r\nC:\\bin\\codex.exe\r\n';
  assert.equal(pickBinary(out, true), 'C:\\bin\\codex.exe');
});
test('windows: .cmd when no .exe; shim alone gives null', () => {
  assert.equal(pickBinary('C:\\npm\\claude\r\nC:\\npm\\claude.cmd\r\n', true), 'C:\\npm\\claude.cmd');
  assert.equal(pickBinary('C:\\npm\\claude\r\n', true), null);
  assert.equal(pickBinary('', true), null);
});
test('posix: first line', () => {
  assert.equal(pickBinary('/usr/bin/codex\n/opt/codex\n', false), '/usr/bin/codex');
  assert.equal(pickBinary('', false), null);
});
