import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FolderPicker, PICKER_UNAVAILABLE, PickerBusyError, pickerCommand } from '../src/folder-picker.ts';

type Done = (err: (Error & { code?: unknown }) | null, stdout: string) => void;
function fakeExec(answer: (done: Done) => void) {
  const calls: { cmd: string; args: string[] }[] = [];
  const execFile = (cmd: string, args: string[], _o: unknown, cb: Done) => { calls.push({ cmd, args }); answer(cb); };
  return { calls, execFile };
}
const err = (code: unknown) => Object.assign(new Error('x'), { code });

test('pickerCommand: a fixed argument list per platform, never a shell', () => {
  const [cmd, args] = pickerCommand('win32')!;
  assert.equal(cmd, 'powershell.exe');
  assert.ok(args.includes('-STA'));
  assert.match(args.at(-1)!, /FolderBrowserDialog/);
  assert.equal(pickerCommand('darwin')![0], 'osascript');
  assert.equal(pickerCommand('linux')![0], 'zenity');
  assert.equal(pickerCommand('aix'), null);
});

test('returns the chosen folder (trailing newline and separator dropped)', async () => {
  const f = fakeExec((done) => done(null, 'C:\\Work\\my-app\\\r\n'));
  const picker = new FolderPicker({ platform: 'win32', execFile: f.execFile, isDir: (p) => p === 'C:\\Work\\my-app' });
  assert.equal(await picker.pick(), 'C:\\Work\\my-app');
  assert.equal(f.calls[0]!.cmd, 'powershell.exe');
});

test('cancel gives null: empty output on Windows, exit code 1 on macOS/Linux', async () => {
  assert.equal(await new FolderPicker({ platform: 'win32', execFile: fakeExec((d) => d(null, '')).execFile, isDir: () => true }).pick(), null);
  assert.equal(await new FolderPicker({ platform: 'darwin', execFile: fakeExec((d) => d(err(1), '')).execFile, isDir: () => true }).pick(), null);
});

test('a path that is not an existing folder gives null', async () => {
  const picker = new FolderPicker({ platform: 'linux', execFile: fakeExec((d) => d(null, '/gone\n')).execFile, isDir: () => false });
  assert.equal(await picker.pick(), null);
});

test('a missing picker program or an unknown platform says to type the path', async () => {
  await assert.rejects(new FolderPicker({ platform: 'linux', execFile: fakeExec((d) => d(err('ENOENT'), '')).execFile }).pick(), new RegExp(PICKER_UNAVAILABLE));
  await assert.rejects(new FolderPicker({ platform: 'aix' }).pick(), new RegExp(PICKER_UNAVAILABLE));
});

test('only one picker at a time; the next one can open after it closes', async () => {
  let finish: Done = () => {};
  const picker = new FolderPicker({ platform: 'win32', execFile: fakeExec((d) => { finish = d; }).execFile, isDir: () => true });
  const first = picker.pick();
  await assert.rejects(picker.pick(), PickerBusyError);
  finish(null, 'C:\\a');
  assert.equal(await first, 'C:\\a');
  const again = picker.pick();
  finish(null, '');
  assert.equal(await again, null);
});
