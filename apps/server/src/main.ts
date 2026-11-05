import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { DesktopToServer, ProviderId, ServerEvent, ServerToDesktop, UsageReading } from '@agent-kanban/shared';
import { Store } from './store.ts';
import { ChatService } from './chats.ts';
import { UsageService, notInstalledReading } from './usage/service.ts';
import { readAllHistory, readTranscript } from './history/index.ts';
import { ClaudeAdapter } from './adapters/claude.ts';
import { CodexAdapter } from './adapters/codex.ts';
import { AntigravityAdapter } from './adapters/antigravity.ts';
import { findInstalledAntigravity, installAntigravity } from './connect/antigravity-install.ts';
import { ConnectService } from './connect/service.ts';
import { spawnCommand } from './connect/run.ts';
import { openBrowser, openLocalApp } from './connect/open-browser.ts';
import { STOP_REQUEST_FILE, watchStopRequest } from './stop-request.ts';
import { FolderPicker } from './folder-picker.ts';
import { FolderOpener } from './folder-opener.ts';
import { SettingsStore } from './settings.ts';
import { SkillService } from './skills/service.ts';
import { skillForm } from './skills/form.ts';
import { readNotes } from './notes.ts';
import { folderKey } from '@agent-kanban/shared';
import { RoutineService } from './routines.ts';
import { AdapterRegistry } from './adapters/registry.ts';
import { findBinary } from './binaries.ts';
import { createApi } from './api.ts';
import { ConnectionMonitor, getLatest, makeGetVersion } from './health.ts';
import { acquireLock, releaseLock } from './lock.ts';
import { AccountService, AccountStore } from './accounts.ts';
import { ClaudeHooks } from './outside/hooks.ts';
import { OutsideSessions } from './outside/sessions.ts';
import { readClaudeSession } from './history/claude.ts';
import { unlinkSync, writeFileSync } from 'node:fs';
import { TrashService } from './trash.ts';
import { KeyService, desktopVault, overCap } from './keys.ts';
import { KeyedAdapters } from './adapters/keyed.ts';

// Last resort: a stray rejection is logged, never allowed to take the server (and every chat) down.
process.on('unhandledRejection', (e) => console.error('[agent-kanban] unhandled', e));

// Started by the desktop app: it hears from us over the IPC channel, never by reading the console, so the
// token is never printed. Browser mode (npm start) has no channel and keeps the console URL.
const desktop = process.env.AGENT_KANBAN_DESKTOP === '1' && typeof process.send === 'function';
// The app ran us as Node with ELECTRON_RUN_AS_NODE; agents must not inherit it, or an Electron tool they start
// (VS Code's `code`, …) would run as plain Node instead of opening.
delete process.env.ELECTRON_RUN_AS_NODE;
const tellDesktop = (m: ServerToDesktop) => new Promise<void>((done) => {
  if (!desktop) return done();
  process.send!(m, undefined, undefined, () => done());
});

// Provider homes (~/.claude, ~/.codex, ~/.gemini) are always the real home. Agent Kanban's own data
// (.agent-kanban: database, lock, the Antigravity install) goes under AGENT_KANBAN_HOME when it is set.
const home = homedir();
const akHome = process.env.AGENT_KANBAN_HOME ? resolve(process.env.AGENT_KANBAN_HOME) : home;
const dataDir = join(akHome, '.agent-kanban');
mkdirSync(dataDir, { recursive: true });
const lockPath = join(dataDir, 'server.lock');
if (!acquireLock(lockPath)) {
  // A crashed server's pid can be reused by another program: say which file to delete if it really isn't running (#19).
  const message = `Agent Kanban is already running. If it isn't, delete ${lockPath} and start it again.`;
  console.error(message);
  await tellDesktop({ type: 'failed', reason: 'locked', message });
  process.exit(1);
}
process.on('exit', () => releaseLock(lockPath));
const store = new Store(join(dataDir, 'agent-kanban.db'));
// Extra accounts (#39) live under the data folder; Default is the provider's own folder.
const accountStore = new AccountStore({ backend: store, root: join(dataDir, 'accounts'), providerHome: { claude: join(homedir(), '.claude'), codex: join(homedir(), '.codex') } });
const token = randomBytes(24).toString('hex');

const PROVIDERS: ProviderId[] = ['claude', 'codex', 'antigravity'];
// Antigravity is Google's pinned release, installed by Agent Kanban under ~/.agent-kanban/providers/antigravity.
const findProvider = (id: ProviderId) =>
  id === 'antigravity' ? Promise.resolve(findInstalledAntigravity(akHome)?.path ?? null) : findBinary(id);
// Adapters are created when a provider's binary is first found, so installing one later needs no restart.
const adapters = new AdapterRegistry({
  findBinary: findProvider,
  create: (id, path) => (id === 'claude' ? new ClaudeAdapter({ claudePath: path, env: () => accountStore.env('claude') })
    : id === 'codex' ? new CodexAdapter({ codexPath: path, env: () => accountStore.env('codex') })
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
// The user's own API keys (#43) live in the desktop app's main process; browser mode has none.
const keys = desktop ? new KeyService({
  vault: desktopVault({ send: (m) => process.send!(m), onMessage: (fn) => process.on('message', fn) }),
  broadcast: (e) => broadcast(e),
}) : undefined;
// A chat on a key runs in its own provider process, spawned with the key in its environment only.
const keyAdapters = keys ? new KeyedAdapters({
  reveal: async (id) => ({ provider: (await keys.get(id)).provider, value: await keys.reveal(id) }),
  create: async (id, env) => {
    const path = await findBinary(id);
    if (!path) return undefined;
    return id === 'claude'
      ? new ClaudeAdapter({ claudePath: path, env: () => ({ ...accountStore.env('claude'), ...env }) })
      : new CodexAdapter({ codexPath: path, env: () => ({ ...accountStore.env('codex'), ...env }) });
  },
}) : undefined;
// Set once skills exists: a `/skill` the user picked is sent in each provider's own form.
let skillNames: () => string[] = () => [];
const chats = new ChatService({
  store, adapters, usage, broadcast: (e) => broadcast(e), claudeHome: join(home, '.claude'),
  ...(keys && keyAdapters ? {
    keyed: keyAdapters,
    // Each turn's cost goes on its key; at the cap, the key's chats stop with "Spend cap reached".
    spend: (keyId: string, usd: number, chatId: string) => {
      keys.addSpend(keyId, usd).then((k) => { if (k && overCap(k)) return chats.capReached(keyId, chatId); })
        .catch((e) => console.error('[agent-kanban] spend', e instanceof Error ? e.message : 'failed'));
    },
    capped: async (keyId: string) => overCap(await keys.get(keyId)),
  } : {}),
  suggestNextSteps: () => settings.get().suggestNextSteps,
  outgoing: (provider, text) => skillForm(provider, text, skillNames()),
  // Notes go with a handoff only when the user turned them on for the project.
  notes: (cwd) => (settings.get().notesProjects ?? []).some((k) => folderKey(k) === folderKey(cwd)) ? readNotes(cwd) : null,
});
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
const routines = new RoutineService({ store, chats, broadcast: (e) => broadcast(e) });
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
  // The check after an operation is always sent (newer checkedAt), so the card stops saying Checking… even when nothing changed.
  onHealth: (health) => broadcast({ type: 'connection.updated', health }),
  home: akHome,
  accountEnv: (id) => accountStore.env(id),
});
connectRef = connect;
// Skill sync writes into the provider homes; AGENT_KANBAN_SKILLS_HOME points it elsewhere for manual tests.
const skills = new SkillService({ home: process.env.AGENT_KANBAN_SKILLS_HOME ? resolve(process.env.AGENT_KANBAN_SKILLS_HOME) : home, settings: () => settings.get() });
skillNames = () => skills.names();
const accounts = new AccountService({
  accounts: accountStore,
  // A turn in progress (Running), not merely a chat the helper still has open: those continue on the new account.
  runningOn: (p) => chats.listChats().some((c) => c.provider === p && c.column === 'running'),
  switched: (p) => {
    (adapters.get(p) as { accountChanged?: () => void } | undefined)?.accountChanged?.();
    usage.refresh(p).catch(() => {});
    connections.check(p).catch(() => {});
  },
  emit: (e) => broadcast(e),
});
// A used reset puts Codex back to work: its out-of-usage chats continue now.
const codexResets = {
  read: async () => { const a = adapters.get('codex'); return a instanceof CodexAdapter ? a.readResetCredits() : 0; },
  use: async () => {
    const a = adapters.get('codex');
    if (!(a instanceof CodexAdapter)) return 'failed';
    const outcome = await a.useResetCredit();
    if (outcome === 'reset') {
      usage.refresh('codex').catch(() => {});
      for (const c of chats.listChats()) {
        if (c.provider === 'codex' && c.column === 'needs_you' && c.needsReason === 'limit') chats.resumeNow(c.id).catch(() => {});
      }
    }
    return outcome;
  },
};
// Claude Code hooks run our script with Node; in the desktop app the server's own binary is Electron run as Node.
const execPath = process.execPath.replace(/\\/g, '/');
const nodeRunner = process.versions.electron ? `ELECTRON_RUN_AS_NODE=1 "${execPath}"` : `"${execPath}"`;
const hookEndpoint = join(dataDir, 'hook-endpoint.json');
const hookSecret = randomBytes(24).toString('hex');
const claudeHooks = new ClaudeHooks({ settingsPath: join(home, '.claude', 'settings.json'), scriptPath: join(dataDir, 'agent-kanban-hook.mjs'), endpointPath: hookEndpoint, runner: nodeRunner });
const outside = new OutsideSessions({ store, emit: (e) => broadcast(e), runningHere: (id) => chats.runningHere(id), claudeHome: join(home, '.claude') });
const trash = new TrashService({ dataDir, home });
trash.start();
const api = createApi({ keys, keyAdapters, codexResets, accounts, routines, hooks: claudeHooks, outside, hookSecret, trash, chats, usage, history: () => readAllHistory(home), token, connections, adapters, connect, settings, skills, folderPicker: new FolderPicker(), folderOpener: new FolderOpener(),
  transcript: (provider, sessionRef) => readTranscript(home, provider, sessionRef) });
broadcast = api.broadcast;

chats.recoverAfterRestart();
skills.sync();

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
  const message = code === 'EADDRINUSE' ? `Port ${port} is already in use. Close the other program or pick another AGENT_KANBAN_PORT.` : `Couldn't start the server: ${(err as Error).message}`;
  console.error(message);
  await tellDesktop({ type: 'failed', reason: 'other', message });
  // The adapters may already hold helper processes: shut them down before leaving.
  await Promise.race([adapters.dispose().catch(() => {}), new Promise((r) => setTimeout(r, 5_000))]);
  process.exit(1);
}
api.server.on('error', (err) => console.error('Server error:', err));
const addr = api.server.address() as AddressInfo;
// The hook script finds this server through this file; it is ours only while we run.
writeFileSync(hookEndpoint, JSON.stringify({ port: addr.port, secret: hookSecret }), { mode: 0o600 });
process.on('exit', () => { try { unlinkSync(hookEndpoint); } catch { /* already gone */ } });
let installedHooks = false;
try { installedHooks = claudeHooks.installed(); } catch { /* unreadable settings: treated as not installed */ }
if (installedHooks) void outside.catchUp(readClaudeSession).catch((e) => console.error('[agent-kanban] outside catch-up', e));
setInterval(() => { try { outside.settleIdle(); } catch (e) { console.error('[agent-kanban] outside settle', e); } }, 60_000).unref();
if (desktop) await tellDesktop({ type: 'ready', port: addr.port, token });
else console.log(`Agent Kanban server: http://127.0.0.1:${addr.port}/?token=${token}`);
// Browser mode can ask for the page to open (AGENT_KANBAN_OPEN_BROWSER=1): the token goes straight to the browser.
if (process.env.AGENT_KANBAN_OPEN_BROWSER === '1') {
  try { openLocalApp(`http://127.0.0.1:${addr.port}/?token=${token}`); } catch (e) { console.error("Couldn't open the browser:", (e as Error).message); }
}
usage.start();
connections.start();
// Catches up runs missed in the past 12 hours, then keeps the timer for the next one.
void routines.start().catch((e) => console.error('Routines failed to start:', e));

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) process.exit(1);
  stopping = true;
  usage.stop();
  connections.stop();
  skills.stop();
  routines.stop();
  trash.dispose();
  // Installs and sign-ins in progress are cancelled; their process trees are killed before we exit.
  const connectDone = connect.dispose().catch(() => {});
  api.server.close();
  api.close();
  const dispose = Promise.all([adapters.dispose(), keyAdapters?.dispose()]);
  await Promise.race([Promise.all([dispose, connectDone]), new Promise((r) => setTimeout(r, 10_000))]);
  api.server.closeAllConnections();
  console.log('Agent Kanban stopped.');
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) process.on(sig, () => void shutdown());
// Dropping a stop.request file in the data folder stops the server (handy for scripts in browser mode).
watchStopRequest(join(dataDir, STOP_REQUEST_FILE), () => void shutdown());
// The desktop app asks us to stop over the channel (signals kill a child outright on Windows). If the app
// itself goes away, the channel closes and we stop too, so no server is left running on its own.
if (desktop) {
  process.on('message', (m) => { if ((m as DesktopToServer | null)?.type === 'stop') void shutdown(); });
  process.on('disconnect', () => void shutdown());
}
// Test harnesses (scripts/e2e-real.ts) stop the server by closing its stdin: a graceful shutdown on every platform.
if (process.env.AGENT_KANBAN_E2E === '1') {
  process.stdin.on('end', () => void shutdown());
  process.stdin.resume();
}
