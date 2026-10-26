import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { ProviderId, ServerEvent, UsageReading } from '@agent-kanban/shared';
import { Store } from './store.ts';
import { ChatService } from './chats.ts';
import { UsageService, notInstalledReading } from './usage/service.ts';
import { readAllHistory } from './history/index.ts';
import { ClaudeAdapter } from './adapters/claude.ts';
import { CodexAdapter } from './adapters/codex.ts';
import { AntigravityAdapter } from './adapters/antigravity.ts';
import { findInstalledAntigravity, installAntigravity } from './connect/antigravity-install.ts';
import { ConnectService } from './connect/service.ts';
import { spawnCommand } from './connect/run.ts';
import { openBrowser } from './connect/open-browser.ts';
import { SettingsStore } from './settings.ts';
import { AdapterRegistry } from './adapters/registry.ts';
import { findBinary } from './binaries.ts';
import { createApi } from './api.ts';
import { ConnectionMonitor, getLatest, makeGetVersion } from './health.ts';
import { acquireLock, releaseLock } from './lock.ts';

// Last resort: a stray rejection is logged, never allowed to take the server (and every chat) down.
process.on('unhandledRejection', (e) => console.error('[agent-kanban] unhandled', e));

// Provider homes (~/.claude, ~/.codex, ~/.gemini) are always the real home. Agent Kanban's own data
// (.agent-kanban: database, lock, the Antigravity install) goes under AGENT_KANBAN_HOME when it is set.
const home = homedir();
const akHome = process.env.AGENT_KANBAN_HOME ? resolve(process.env.AGENT_KANBAN_HOME) : home;
const dataDir = join(akHome, '.agent-kanban');
mkdirSync(dataDir, { recursive: true });
const lockPath = join(dataDir, 'server.lock');
if (!acquireLock(lockPath)) {
  console.error('Agent Kanban is already running.');
  process.exit(1);
}
process.on('exit', () => releaseLock(lockPath));
const store = new Store(join(dataDir, 'agent-kanban.db'));
const token = randomBytes(24).toString('hex');

const PROVIDERS: ProviderId[] = ['claude', 'codex', 'antigravity'];
// Antigravity is Google's pinned release, installed by Agent Kanban under ~/.agent-kanban/providers/antigravity.
const findProvider = (id: ProviderId) =>
  id === 'antigravity' ? Promise.resolve(findInstalledAntigravity(akHome)?.path ?? null) : findBinary(id);
// Adapters are created when a provider's binary is first found, so installing one later needs no restart.
const adapters = new AdapterRegistry({
  findBinary: findProvider,
  create: (id, path) => (id === 'claude' ? new ClaudeAdapter({ claudePath: path })
    : id === 'codex' ? new CodexAdapter({ codexPath: path })
      : new AntigravityAdapter({ exePath: path })),
});
// Creating an adapter starts nothing: the Antigravity agent (slow to start) is launched only by a chat or sign-in.
await Promise.all(PROVIDERS.map((id) => adapters.ensure(id)));

let broadcast: (e: ServerEvent) => void = () => {};
const readers: Partial<Record<ProviderId, () => Promise<UsageReading>>> = {};
for (const id of PROVIDERS) {
  readers[id] = async () => {
    const a = await adapters.ensure(id);
    if (!a) return notInstalledReading(id);
    return a.readUsage();
  };
}
const usage = new UsageService({
  readers, store, onUpdate: (reading) => broadcast({ type: 'usage.updated', reading }),
});
const chats = new ChatService({ store, adapters, usage, broadcast: (e) => broadcast(e), claudeHome: join(home, '.claude') });
/** Set once ConnectService exists; the monitor's first check runs after that. */
let connectRef: ConnectService | null = null;
const connections = new ConnectionMonitor({
  providers: PROVIDERS,
  findBinary: findProvider,
  getVersion: makeGetVersion(() => findInstalledAntigravity(akHome)?.version ?? null), getLatest, adapters,
  onUpdate: (health) => {
    broadcast({ type: 'connection.updated', health });
    // A check that shows the last connect failure no longer holds clears it (e.g. signed in from a terminal).
    connectRef?.noteHealth(health);
  },
});
const settings = new SettingsStore(store);
const connect = new ConnectService({
  run: spawnCommand,
  npmPath: () => findBinary('npm'),
  findBinary: (id) => findBinary(id),
  antigravity: {
    install: installAntigravity,
    adapter: async () => {
      const a = await adapters.ensure('antigravity');
      return a instanceof AntigravityAdapter ? a : undefined;
    },
  },
  openBrowser: (url) => openBrowser(url),
  monitor: connections,
  registry: adapters,
  onUpdate: (state) => broadcast({ type: 'connect.updated', state }),
  home: akHome,
});
connectRef = connect;
const api = createApi({ chats, usage, history: () => readAllHistory(home), token, connections, adapters, connect, settings });
broadcast = api.broadcast;

chats.recoverAfterRestart();

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
  // The adapters may already hold helper processes: shut them down before leaving.
  await Promise.race([adapters.dispose().catch(() => {}), new Promise((r) => setTimeout(r, 5_000))]);
  process.exit(1);
}
api.server.on('error', (err) => console.error('Server error:', err));
const addr = api.server.address() as AddressInfo;
console.log(`Agent Kanban server: http://127.0.0.1:${addr.port}/?token=${token}`);
usage.start();
connections.start();

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) process.exit(1);
  stopping = true;
  usage.stop();
  connections.stop();
  // Installs and sign-ins in progress are cancelled; their process trees are killed before we exit.
  const connectDone = connect.dispose().catch(() => {});
  api.server.close();
  api.close();
  const dispose = adapters.dispose();
  await Promise.race([Promise.all([dispose, connectDone]), new Promise((r) => setTimeout(r, 10_000))]);
  api.server.closeAllConnections();
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) process.on(sig, () => void shutdown());
// Test harnesses (scripts/e2e-real.ts) stop the server by closing its stdin: a graceful shutdown on every platform.
if (process.env.AGENT_KANBAN_E2E === '1') {
  process.stdin.on('end', () => void shutdown());
  process.stdin.resume();
}
