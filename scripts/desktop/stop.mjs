// "Stop Agent Kanban": asks the running server to shut down cleanly (it watches for this file), then waits for it.
import { existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const dataDir = join(process.env.AGENT_KANBAN_HOME ? resolve(process.env.AGENT_KANBAN_HOME) : homedir(), '.agent-kanban');
const lock = join(dataDir, 'server.lock');
const say = (line) => process.stdout.write(`${line}\n`);

if (!existsSync(lock)) {
  say('Agent Kanban is not running.');
} else {
  writeFileSync(join(dataDir, 'stop.request'), '');
  say('Stopping Agent Kanban…');
  const deadline = Date.now() + 20_000;
  while (existsSync(lock) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
  say(existsSync(lock) ? "Agent Kanban didn't stop in time. Close its window instead." : 'Agent Kanban stopped.');
}
await new Promise((r) => setTimeout(r, 2_500));
