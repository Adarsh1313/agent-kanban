import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { ProviderId, ServerEvent, UsageReading } from '@agent-kanban/shared';
import { Store } from './store.ts';
import { ChatService } from './chats.ts';
import { UsageService } from './usage/service.ts';
import { readAllHistory } from './history/index.ts';
import { ClaudeAdapter } from './adapters/claude.ts';
import { CodexAdapter } from './adapters/codex.ts';
import type { ProviderAdapter } from './adapters/adapter.ts';
import { findBinary } from './binaries.ts';
import { createApi } from './api.ts';
import { ConnectionMonitor, getLatest, getVersion } from './health.ts';

const home = homedir();
const dataDir = join(home, '.agent-kanban');
mkdirSync(dataDir, { recursive: true });
const store = new Store(join(dataDir, 'agent-kanban.db'));
const token = randomBytes(24).toString('hex');

const [claudePath, codexPath] = await Promise.all([findBinary('claude'), findBinary('codex')]);
const adapters: Partial<Record<ProviderId, ProviderAdapter>> = {};
if (claudePath) adapters.claude = new ClaudeAdapter({ claudePath });
if (codexPath) adapters.codex = new CodexAdapter({ codexPath });

let broadcast: (e: ServerEvent) => void = () => {};
const readers: Partial<Record<ProviderId, () => Promise<UsageReading>>> = {};
for (const [id, a] of Object.entries(adapters) as [ProviderId, ProviderAdapter][]) readers[id] = () => a.readUsage();
const usage = new UsageService({
  readers, store, onUpdate: (reading) => broadcast({ type: 'usage.updated', reading }),
});
const chats = new ChatService({ store, adapters, usage, broadcast: (e) => broadcast(e), claudeHome: join(home, '.claude') });
const connections = new ConnectionMonitor({
  providers: ['claude', 'codex'],
  findBinary: (id) => (id === 'claude' || id === 'codex' ? findBinary(id) : Promise.resolve(null)),
  getVersion, getLatest, adapters,
  onUpdate: (health) => broadcast({ type: 'connection.updated', health }),
});
const api = createApi({ chats, usage, history: () => readAllHistory(home), token, connections });
broadcast = api.broadcast;

chats.recoverAfterRestart();
usage.start();

const rawPort = process.env.AGENT_KANBAN_PORT;
let port = 0;
if (rawPort !== undefined && rawPort !== '') {
  const n = Number(rawPort);
  if (Number.isInteger(n) && n >= 0 && n <= 65535) port = n;
  else console.warn(`AGENT_KANBAN_PORT "${rawPort}" isn't a valid port, so a random free port will be used.`);
}
try {
  await new Promise<void>((resolve, reject) => {
    api.server.once('error', reject);
    api.server.listen(port, '127.0.0.1', resolve);
  });
} catch (err) {
  const code = (err as NodeJS.ErrnoException).code;
  console.error(code === 'EADDRINUSE' ? `Port ${port} is already in use. Close the other program or pick another AGENT_KANBAN_PORT.` : `Couldn't start the server: ${(err as Error).message}`);
  process.exit(1);
}
api.server.on('error', (err) => console.error('Server error:', err));
const addr = api.server.address() as AddressInfo;
console.log(`Agent Kanban server: http://127.0.0.1:${addr.port}/?token=${token}`);
connections.start();

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) process.exit(1);
  stopping = true;
  usage.stop();
  connections.stop();
  api.server.close();
  api.close();
  const dispose = Promise.allSettled(Object.values(adapters).map((a) => Promise.resolve().then(() => a.dispose())));
  await Promise.race([dispose, new Promise((r) => setTimeout(r, 5_000))]);
  api.server.closeAllConnections();
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) process.on(sig, () => void shutdown());
