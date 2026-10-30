import { describe, expect, it } from 'vitest';
import { inFolder } from '../src/ui/board/format.ts';

describe('inFolder (#7)', () => {
  it('shows paths inside the chat folder relative to it, whatever the case or slash direction', () => {
    const cwd = String.raw`C:\Users\Adarsh\work\proj-codex`;
    expect(inFolder(String.raw`Editing C:\Users\Adarsh\work\proj-codex\notes.txt`, cwd)).toBe('Editing notes.txt');
    expect(inFolder(String.raw`Editing c:/users/adarsh/work/proj-codex/src/a.ts`, cwd + '\\')).toBe('Editing src/a.ts');
    expect(inFolder('Editing /home/me/app/src/a.ts and /home/me/app/b.ts', '/home/me/app')).toBe('Editing src/a.ts and b.ts');
  });
  it('leaves text outside the folder, a sibling folder with the same prefix, and an empty folder alone', () => {
    expect(inFolder(String.raw`Editing C:\other\x.txt`, String.raw`C:\work`)).toBe(String.raw`Editing C:\other\x.txt`);
    expect(inFolder('Editing /home/me/app2/x.ts', '/home/me/app')).toBe('Editing /home/me/app2/x.ts');
    expect(inFolder('Running npm test', '')).toBe('Running npm test');
    expect(inFolder('Paths (a+b) [x]', '/w/(a+b)')).toBe('Paths (a+b) [x]');
  });
});
