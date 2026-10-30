// Desktop launcher: builds the web app, starts the server on port 3006 and opens it in the default browser.
// Keep its window open while you use Agent Kanban; closing it (or Ctrl+C, or the Stop shortcut) stops the server
// cleanly. Run from the desktop shortcut (scripts/desktop/install-shortcuts.mjs) or `npm run desktop`.
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
process.title = 'Agent Kanban';
const say = (line = '') => process.stdout.write(`${line}\n`);

say('Agent Kanban');
say('Getting the latest version of the app ready…');
// One fixed command line (npm is a .cmd shim on Windows, which needs a shell); nothing user-supplied goes into it.
const build = spawnSync('npm run build --silent', { cwd: root, stdio: ['ignore', 'ignore', 'inherit'], shell: true });
if (build.status !== 0) {
  say("Couldn't build the app. Run `npm install` in the project folder, then try again.");
  await holdWindow();
}

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(root, 'apps', 'server', 'src', 'main.ts')], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'inherit'],
  env: { ...process.env, AGENT_KANBAN_PORT: process.env.AGENT_KANBAN_PORT || '3006', AGENT_KANBAN_OPEN_BROWSER: '1' },
});
server.stdout.setEncoding('utf8');
server.stdout.on('data', (chunk) => {
  for (const line of chunk.split(/\r?\n/)) {
    if (!line) continue;
    // The address line carries the session token: say where it runs, never print the token.
    if (line.startsWith('Agent Kanban server: ')) {
      say(`Running at http://127.0.0.1:${new URL(line.slice(21)).port}. Your browser opened it.`);
      say('Keep this window open while you use Agent Kanban.');
      say('To stop: close this window, press Ctrl+C, or use the "Stop Agent Kanban" shortcut.');
    } else say(line);
  }
});

// Ctrl+C and closing the window reach the server too; the launcher just waits for it to finish shutting down.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sig, () => {});
server.on('exit', async (code) => {
  if (code === 0) process.exit(0);
  say();
  say('Agent Kanban is already running, or it stopped with an error (see above).');
  say('If it is already running, use its browser tab, or stop it first with the "Stop Agent Kanban" shortcut.');
  await holdWindow();
});

/** Leaves the message on screen for a while before the window closes. */
async function holdWindow() {
  await new Promise((r) => setTimeout(r, 30_000));
  process.exit(1);
}
