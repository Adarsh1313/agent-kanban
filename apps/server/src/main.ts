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
const api = createApi({ chats, usage, history: () => readAllHistory(home), token });
broadcast = api.broadcast;

chats.recoverAfterRestart();
usage.start();

const port = Number(process.env.AGENT_KANBAN_PORT ?? 0) || 0;
await new Promise<void>((resolve, reject) => {
  api.server.once('error', reject);
  api.server.listen(port, '127.0.0.1', resolve);
});
const addr = api.server.address() as AddressInfo;
console.log(`Agent Kanban server: http://127.0.0.1:${addr.port}/?token=${token}`);

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  usage.stop();
  const dispose = Promise.allSettled(Object.values(adapters).map((a) => a.dispose()));
  await Promise.race([dispose, new Promise((r) => setTimeout(r, 5_000))]);
  api.close();
  api.server.closeAllConnections();
  api.server.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
