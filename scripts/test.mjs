// Runs the server tests (node --test) and then the web tests (vitest), always both,
// and exits with the worst exit code so a failure in either fails `npm test`.
import { spawnSync } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const runs = [
  [process.execPath, ['--test', '--disable-warning=ExperimentalWarning', 'apps/server/test/**/*.test.ts', 'apps/desktop/test/**/*.test.ts']],
  [npm, ['test', '-w', 'apps/web']],
];

let worst = 0;
for (const [cmd, args] of runs) {
  // shell is needed to launch npm.cmd on Windows; the arguments contain no user input.
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: cmd === npm && process.platform === 'win32' });
  const code = r.status ?? 1;
  if (r.error) console.error(r.error.message);
  worst = Math.max(worst, code);
}
process.exit(worst);
