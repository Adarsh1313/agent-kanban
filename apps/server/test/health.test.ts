import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { ConnectionHealth, ProviderId } from '@agent-kanban/shared';
import { ConnectionMonitor, getVersion, parseVersion } from '../src/health.ts';

type Ping = { ok: boolean; signedIn: boolean | null; message?: string };

function setup(over: {
  found?: (id: ProviderId) => string | null;
  version?: string | null;
  latest?: () => Promise<string | null>;
  ping?: () => Promise<Ping>;
  providers?: ProviderId[];
  healthMs?: number;
  versionMs?: number;
  retryMs?: number;
  versions?: () => string | null;
  latest2?: () => string | null;
  restart?: () => Promise<boolean>;
  hasAdapter?: () => boolean;
} = {}) {
  const pings: ProviderId[] = [];
  const latestCalls: ProviderId[] = [];
  const versionCalls: ProviderId[] = [];
  const updates: ConnectionHealth[] = [];
  const manuals: boolean[] = [];
  const restarts: ProviderId[] = [];
  const adapter = (id: ProviderId) => ({
    id,
    ping: async (o?: { manual?: boolean }) => { pings.push(id); manuals.push(o?.manual === true); return (over.ping ?? (async () => ({ ok: true, signedIn: true })))(); },
    restartIfIdle: async () => { restarts.push(id); return over.restart ? over.restart() : true; },
  });
  const providers = over.providers ?? (['codex'] as ProviderId[]);
  const monitor = new ConnectionMonitor({
    providers,
    findBinary: async (id) => (over.found ? over.found(id) : `C:\\bin\\${id}.exe`),
    getVersion: async (id) => { versionCalls.push(id); return over.versions ? over.versions() : over.version === undefined ? '0.163.0' : over.version; },
    getLatest: async (id) => { latestCalls.push(id); return over.latest ? over.latest() : '0.163.0'; },
    adapters: { ensure: async (id) => (over.hasAdapter && !over.hasAdapter() ? undefined : (adapter(id) as never)) },
    onUpdate: (h) => updates.push(h),
    now: () => new Date('2026-10-22T10:00:00Z'),
    ...(over.healthMs ? { healthMs: over.healthMs } : {}),
    ...(over.versionMs ? { versionMs: over.versionMs } : {}),
    ...(over.retryMs ? { retryMs: over.retryMs } : {}),
  });
  return { monitor, pings, latestCalls, versionCalls, updates, manuals, restarts };
}

test('installed 0.163.0, latest 0.163.0, ping ok and signed in is connected', async () => {
  const s = setup();
  const [h] = await s.monitor.check();
  assert.deepEqual(h, {
    provider: 'codex', installed: true, path: 'C:\\bin\\codex.exe', version: '0.163.0', latestVersion: '0.163.0',
    updateAvailable: false, signedIn: true, processOk: true, status: 'connected', message: null, checkedAt: '2026-10-22T10:00:00.000Z',
  });
});

test('a newer latest version gives update_available with the message', async () => {
  const s = setup({ latest: async () => '0.164.0' });
  const [h] = await s.monitor.check();
  assert.equal(h!.status, 'update_available');
  assert.equal(h!.updateAvailable, true);
  assert.equal(h!.message, 'Codex 0.164.0 is available (you have 0.163.0).');
});

test('version comparison is numeric, and an older latest is not an update', async () => {
  const s = setup({ version: '0.9.0', latest: async () => '0.10.0' });
  assert.equal((await s.monitor.check())[0]!.updateAvailable, true);
  const t = setup({ version: '0.164.0', latest: async () => '0.163.0' });
  assert.equal((await t.monitor.check())[0]!.updateAvailable, false);
});

test('offline registry leaves latestVersion null and the status connected', async () => {
  const s = setup({ latest: async () => { throw new Error('offline'); } });
  const [h] = await s.monitor.check();
  assert.equal(h!.latestVersion, null);
  assert.equal(h!.status, 'connected');
  assert.equal(h!.updateAvailable, false);
});

test('no binary is not_installed and the adapter is not pinged', async () => {
  const s = setup({ found: () => null });
  const [h] = await s.monitor.check();
  assert.equal(h!.status, 'not_installed');
  assert.equal(h!.installed, false);
  assert.equal(h!.path, null);
  assert.equal(h!.message, "Codex isn't installed.");
  assert.equal(s.pings.length, 0);
});

test('ping signedIn false is signed_out, ahead of update_available', async () => {
  const s = setup({ ping: async () => ({ ok: true, signedIn: false }), latest: async () => '9.9.9' });
  const [h] = await s.monitor.check();
  assert.equal(h!.status, 'signed_out');
  assert.equal(h!.signedIn, false);
  assert.equal(h!.processOk, true);
  assert.equal(h!.message, "Codex isn't signed in.");
});

test('a rejected ping is degraded with processOk false, and onUpdate fires once per change', async () => {
  let fail = true;
  const s = setup({ ping: async () => { if (fail) throw new Error('dead'); return { ok: true, signedIn: true }; } });
  const [h] = await s.monitor.check();
  assert.equal(h!.status, 'degraded');
  assert.equal(h!.processOk, false);
  assert.equal(h!.message, "Codex didn't respond. Restarting it…");
  await s.monitor.check();
  await s.monitor.check();
  assert.equal(s.updates.length, 1, 'identical checks do not emit');
  fail = false;
  await s.monitor.check();
  assert.equal(s.updates.length, 2);
  assert.equal(s.updates[1]!.status, 'connected');
  assert.deepEqual(s.monitor.latest().map((x) => x.status), ['connected']);
});

test('a ping that returns ok false is also degraded; a changed checkedAt alone does not emit', async () => {
  let clock = new Date('2026-10-22T10:00:00Z');
  const updates: ConnectionHealth[] = [];
  const monitor = new ConnectionMonitor({
    providers: ['claude'], findBinary: async () => 'c', getVersion: async () => '2.1.308', getLatest: async () => '2.1.308',
    adapters: { ensure: async () => ({ id: 'claude', ping: async () => ({ ok: false, signedIn: null }) }) as never },
    onUpdate: (h) => updates.push(h), now: () => clock,
  });
  const [h] = await monitor.check();
  assert.equal(h!.status, 'degraded');
  assert.equal(h!.message, "Claude Code didn't respond. Restarting it…");
  clock = new Date('2026-10-22T10:05:00Z');
  const [h2] = await monitor.check();
  assert.equal(h2!.checkedAt, '2026-10-22T10:05:00.000Z');
  assert.equal(updates.length, 1);
});

test('the Codex model note shows in the message while connected, without changing the status', async () => {
  const note = "Your Codex settings use gpt-9, which your account can't use, so new chats use gpt-5.";
  const s = setup({ ping: async () => ({ ok: true, signedIn: true, message: note }) });
  const [h] = await s.monitor.check();
  assert.equal(h!.status, 'connected');
  assert.equal(h!.message, `Connected. ${note}`);
  const t = setup({ ping: async () => ({ ok: true, signedIn: true, message: note }), latest: async () => '9.9.9' });
  assert.equal((await t.monitor.check())[0]!.status, 'update_available');
});

test('check(provider) checks just that provider', async () => {
  const s = setup({ providers: ['claude', 'codex'] });
  const r = await s.monitor.check('codex');
  assert.deepEqual(r.map((h) => h.provider), ['codex']);
  assert.deepEqual(s.pings, ['codex']);
  assert.deepEqual((await s.monitor.check()).map((h) => h.provider), ['claude', 'codex']);
});

test('concurrent checks for one provider share a single ping', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const s = setup({ ping: async () => { await gate; return { ok: true, signedIn: true }; } });
  const a = s.monitor.check();
  const b = s.monitor.check();
  await new Promise((r) => setImmediate(r));
  release();
  await Promise.all([a, b]);
  assert.equal(s.pings.length, 1);
});

test('health checks every 60 s; the registry at start and then every 6 h only', async () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  const s = setup();
  try {
    s.monitor.start();
    await flush();
    assert.equal(s.pings.length, 1);
    assert.equal(s.latestCalls.length, 1);
    for (let i = 1; i <= 3; i++) { mock.timers.tick(60_000); await flush(); }
    assert.equal(s.pings.length, 4);
    assert.equal(s.latestCalls.length, 1, 'not every minute');
    mock.timers.tick(6 * 3_600_000 - 3 * 60_000);
    await flush();
    assert.equal(s.latestCalls.length, 2);
    assert.ok(s.versionCalls.length >= 2, 'the installed version is re-read every tick');
    s.monitor.stop();
    mock.timers.tick(10 * 60_000);
    await flush();
    const after = s.pings.length;
    mock.timers.tick(10 * 60_000);
    await flush();
    assert.equal(s.pings.length, after, 'stop() ends the timers');
  } finally { s.monitor.stop(); mock.timers.reset(); }
});

test('a degraded provider is re-checked soon (retryMs), not only a minute later', async () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  let fail = true;
  const s = setup({ retryMs: 5000, ping: async () => (fail ? { ok: false, signedIn: null } : { ok: true, signedIn: true }) });
  try {
    s.monitor.start();
    await flush();
    assert.equal(s.updates.at(-1)!.status, 'degraded');
    fail = false;
    mock.timers.tick(5000);
    await flush();
    assert.equal(s.updates.at(-1)!.status, 'connected');
  } finally { s.monitor.stop(); mock.timers.reset(); }
});

test('parseVersion reads both real --version formats', () => {
  assert.equal(parseVersion('2.1.308 (Claude Code)'), '2.1.308');
  assert.equal(parseVersion('codex-cli 0.163.0\n'), '0.163.0');
  assert.equal(parseVersion('nothing here'), null);
});

test('getVersion runs <path> --version and parses the first x.y.z', async () => {
  // `node --version` prints v<x.y.z>, which exercises the real spawn path.
  assert.equal(await getVersion('codex', process.execPath), process.versions.node);
  assert.equal(await getVersion('codex', fileURLToPath(new URL('./does-not-exist.exe', import.meta.url))), null);
});

test('a give-up message from the adapter is shown and counts as a change', async () => {
  let msg: string | undefined;
  const s = setup({ ping: async () => ({ ok: false, signedIn: null, ...(msg ? { message: msg } : {}) }) });
  assert.equal((await s.monitor.check())[0]!.message, "Codex didn't respond. Restarting it…");
  msg = 'Codex keeps stopping. Use Check now to try again.';
  const [h] = await s.monitor.check();
  assert.equal(h!.status, 'degraded');
  assert.equal(h!.message, msg);
  assert.equal(s.updates.length, 2);
});

test('a provider installed after start is picked up by the next check', async () => {
  let installed = false;
  let binary: string | null = null;
  const s = setup({ found: () => binary, hasAdapter: () => installed });
  assert.equal((await s.monitor.check())[0]!.status, 'not_installed');
  installed = true; binary = 'C:\bin\codex.exe';
  const [h] = await s.monitor.check();
  assert.equal(h!.status, 'connected');
  assert.equal(h!.installed, true);
});

test('a manual check waits for the periodic check in flight, then runs its own with manual set', async () => {
  let release: () => void = () => {};
  let first = true;
  const gate = new Promise<void>((r) => { release = r; });
  const s = setup({ ping: async () => { if (first) { first = false; await gate; } return { ok: true, signedIn: true }; } });
  s.monitor.start();
  await new Promise((r) => setImmediate(r));
  const manual = s.monitor.check();
  await new Promise((r) => setImmediate(r));
  assert.equal(s.pings.length, 1, 'still waiting for the first');
  release();
  await manual;
  s.monitor.stop();
  assert.deepEqual(s.manuals, [false, true]);
});

test('an unknown latest version is retried on the next health tick, not after 6 h', async () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  let value: string | null = null;
  const s = setup({ latest: async () => value });
  try {
    s.monitor.start();
    await flush();
    assert.equal(s.latestCalls.length, 1);
    assert.equal(s.monitor.latest()[0]!.latestVersion, null);
    value = '0.164.0';
    mock.timers.tick(60_000);
    await flush();
    assert.equal(s.latestCalls.length, 2);
    assert.equal(s.monitor.latest()[0]!.latestVersion, '0.164.0');
    mock.timers.tick(60_000);
    await flush();
    assert.equal(s.latestCalls.length, 2, 'known now: back to every 6 h');
  } finally { s.monitor.stop(); mock.timers.reset(); }
});

test('when the installed version changes, an idle helper process is restarted', async () => {
  let v = '0.163.0';
  const s = setup({ versions: () => v });
  await s.monitor.check();
  assert.deepEqual(s.restarts, []);
  v = '0.164.0';
  const [h] = await s.monitor.check();
  assert.deepEqual(s.restarts, ['codex']);
  assert.equal(h!.version, '0.164.0');
  await s.monitor.check();
  assert.equal(s.restarts.length, 1);
});

test('a pending restart is retried every check until the helper is idle', async () => {
  let v = '0.163.0';
  const outcomes = [false, false, true];
  const s = setup({ versions: () => v, restart: async () => outcomes.shift() ?? true });
  await s.monitor.check();
  v = '0.164.0';
  await s.monitor.check(); // a turn is running: not restarted yet
  await s.monitor.check(); // still running
  assert.equal(s.restarts.length, 2);
  await s.monitor.check(); // turn ended: restarted
  assert.equal(s.restarts.length, 3);
  await s.monitor.check();
  assert.equal(s.restarts.length, 3, 'done: not repeated');
});
