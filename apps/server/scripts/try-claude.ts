// Manual check: node apps/server/scripts/try-claude.ts "list the files here"
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ClaudeAdapter } from '../src/adapters/claude.ts';

const claudePath = execFileSync('where', ['claude'], { encoding: 'utf8' }).split(/\r?\n/).map((l) => l.trim()).find((l) => /\.(cmd|exe)$/i.test(l))!;
const cwd = mkdtempSync(path.join(tmpdir(), 'try-claude-'));
writeFileSync(path.join(cwd, 'hello.txt'), 'hi');
const a = new ClaudeAdapter({ claudePath });
const done = new Promise<void>((resolve) => a.onEvent((e) => {
  console.log(e.type, JSON.stringify(e).slice(0, 160));
  if (e.type === 'request.opened') void a.respondToRequest(e.sessionRef, e.requestId, 'allow');
  if (e.type === 'turn.completed' || e.type === 'error') resolve();
}));
const { sessionRef } = await a.startChat({ cwd, prompt: process.argv[2] ?? 'list the files here' });
console.log('sessionRef', sessionRef, 'cwd', cwd);
await done;
console.log('usage', JSON.stringify(await a.readUsage()));
await a.dispose();
process.exit(0);
