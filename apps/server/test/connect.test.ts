// ConnectService against a fake CommandRunner: nothing real is installed, signed in or opened, and no
// provider home (~/.claude, ~/.codex, ~/.gemini) is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { ConnectState, ProviderId } from '@agent-kanban/shared';
import {
  ConnectService, ConnectBusyError, SIGN_IN_TIMEOUT_MS, POLL_MS, SIGN_IN_DIDNT_FINISH, NETWORK_FAILED,
  ANTIGRAVITY_SIGN_OUT_IN_APP, findHttpsUrl,
} from '../src/connect/service.ts';
import type { AntigravityAuth } from '../src/connect/service.ts';
import type { CommandExit, CommandRunner, RunningCommand } from '../src/connect/run.ts';
import { commandTarget, spawnCommand } from '../src/connect/run.ts';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBrowser, ONLY_HTTPS } from '../src/connect/open-browser.ts';
import { DOWNLOAD_FAILED } from '../src/connect/antigravity-install.ts';
import type { InstallOptions } from '../src/connect/antigravity-install.ts';
import { createApi } from '../src/api.ts';

const flush = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

interface Reply { out?: string; code?: number | null; errorCode?: string; hang?: boolean }
interface Call { cmd: string; args: string[]; killed: boolean; exited: boolean }

/** Scripted processes: `script` decides each command's output and exit; `hang` waits until killed. */
function fakeRunner(script: (cmd: string, args: string[]) => Reply) {
  const calls: Call[] = [];
  const run: CommandRunner = (cmd, args) => {
    const call: Call = { cmd, args, killed: false, exited: false };
    calls.push(call);
    const reply = script(cmd, args);
    const fns: Array<(t: string) => void> = [];
    let resolveExit!: (e: CommandExit) => void;
    const exited = new Promise<CommandExit>((r) => { resolveExit = r; });
    const exit = (e: CommandExit) => { if (!call.exited) { call.exited = true; resolveExit(e); } };
    void Promise.resolve().then(() => {
      if (reply.out) for (const fn of fns) fn(reply.out);
      if (!reply.hang) exit({ code: reply.code ?? 0, ...(reply.errorCode ? { errorCode: reply.errorCode } : {}) });
    });
    const proc: RunningCommand = {
      onOutput: (fn) => { fns.push(fn); },
      exited,
      kill: () => { call.killed = true; exit({ code: null }); },
    };
    return proc;
  };
  const alive = () => calls.filter((c) => !c.exited);
  return { run, calls, alive };
}

const is = (c: Call, ...args: string[]) => args.every((a, i) => c.args[i] === a);

function make(opts: {
  script: (cmd: string, args: string[]) => Reply;
  npm?: string | null;
  bins?: Partial<Record<'claude' | 'codex', string | null>>;
  install?: (o: InstallOptions) => Promise<{ path: string; version: string }>;
  adapter?: AntigravityAuth;
  /** false: claude / codex are found only after an npm install finished. */
  installed?: boolean;
}) {
  const r = fakeRunner(opts.script);
  const updates: ConnectState[] = [];
  const checks: (ProviderId | undefined)[] = [];
  const ensured: [ProviderId, string | undefined][] = [];
  const opened: string[] = [];
  const svc = new ConnectService({
    run: r.run,
    npmPath: async () => (opts.npm === undefined ? '/usr/bin/npm' : opts.npm),
    findBinary: async (id) => {
      if (opts.bins && id in opts.bins) return opts.bins[id]!;
      const npmDone = r.calls.some((c) => c.args[0] === 'install' && c.exited && !c.killed);
      return opts.installed === false && !npmDone ? null : `/bin/${id}`;
    },
    antigravity: {
      install: opts.install ?? (async () => ({ path: '/ak/agy', version: '1.3.0' })),
      adapter: async () => opts.adapter,
    },
    openBrowser: (u) => { opened.push(u); },
    monitor: { check: async (id) => { checks.push(id); return []; } },
    registry: { ensure: async (id, p) => { ensured.push([id, p]); return undefined; } },
    onUpdate: (s) => updates.push(s),
    home: '/nonexistent-ak-home',
  });
  const last = (id: ProviderId) => svc.states().find((s) => s.provider === id)!;
  return { svc, ...r, updates, checks, ensured, opened, last };
}

const NPM_OK = 'npm http fetch GET 200 https://registry.npmjs.org/@openai%2fcodex 120ms\nnpm http fetch GET 200 https://registry.npmjs.org/@openai/codex/-/codex-0.200.0.tgz 900ms\nadded 1 package in 3s\n';
const CODEX_URL = 'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_x&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=abc';

test('install Codex: npm install -g @openai/codex@latest, steps Downloading → Installing → done, then registry + health check', async () => {
  const t = make({ script: (cmd) => (cmd === '/usr/bin/npm' ? { out: NPM_OK } : {}), installed: false });
  const s = t.svc.install('codex');
  assert.equal(s.phase, 'installing');
  await flush();
  const npm = t.calls[0]!;
  assert.equal(npm.cmd, '/usr/bin/npm');
  assert.deepEqual(npm.args.slice(0, 3), ['install', '-g', '@openai/codex@latest']);
  const steps = t.updates.filter((u) => u.provider === 'codex').map((u) => u.step);
  assert.ok(steps.includes('Downloading Codex…'));
  assert.ok(steps.includes('Installing'));
  const progress = t.updates.map((u) => u.progress).filter((p): p is number => p !== null);
  assert.ok(progress.every((p, i) => i === 0 || p >= progress[i - 1]!), 'progress only goes up');
  const end = t.last('codex');
  assert.equal(end.phase, 'idle');
  assert.equal(end.message, null);
  assert.deepEqual(t.ensured, [['codex', '/bin/codex']]);
  assert.deepEqual(t.checks, ['codex']);
});

test('install Claude Code uses the official npm package', async () => {
  const t = make({ script: () => ({ out: 'added 3 packages\n' }), installed: false });
  t.svc.install('claude');
  await flush();
  assert.deepEqual(t.calls[0]!.args.slice(0, 3), ['install', '-g', '@anthropic-ai/claude-code@latest']);
  assert.equal(t.last('claude').phase, 'idle');
});

test('EACCES / EPERM on the global install → the plain "didn\'t allow it" message, no half state', async () => {
  for (const code of ['EACCES', 'EPERM']) {
    const t = make({ script: () => ({ out: `npm error code ${code}\nnpm error syscall mkdir\n`, code: 243 }), installed: false });
    t.svc.install('codex');
    await flush();
    const end = t.last('codex');
    assert.equal(end.phase, 'error');
    assert.equal(end.message, "Couldn't install Codex: your computer didn't allow it. Try running Agent Kanban as an administrator, or install Codex yourself.");
    assert.equal(end.step, null);
    assert.equal(end.progress, null);
    assert.deepEqual(t.ensured, []);
    assert.deepEqual(t.checks, ['codex']); // health re-read so the card shows what is really there
    assert.equal(t.svc.busy('codex'), false);
  }
});

test('install when the CLI is already there (installed outside the app) → no reinstall, just picked up', async () => {
  const t = make({ script: () => ({ out: NPM_OK }) });
  t.svc.install('codex');
  await flush();
  assert.equal(t.calls.length, 0);
  assert.equal(t.last('codex').phase, 'idle');
  assert.deepEqual(t.ensured, [['codex', '/bin/codex']]);
  assert.deepEqual(t.checks, ['codex']);
});

test('update always runs npm @latest, even when installed', async () => {
  const t = make({ script: () => ({ out: NPM_OK }) });
  assert.equal(t.svc.update('codex').phase, 'updating');
  await flush();
  assert.deepEqual(t.calls[0]!.args.slice(0, 3), ['install', '-g', '@openai/codex@latest']);
  assert.equal(t.last('codex').phase, 'idle');
});

test('npm missing → "Agent Kanban needs npm…"; nothing is run', async () => {
  const t = make({ script: () => ({}), npm: null, installed: false });
  t.svc.install('claude');
  await flush();
  assert.equal(t.last('claude').phase, 'error');
  assert.equal(t.last('claude').message, 'Agent Kanban needs npm to install Claude Code. Install Node.js from nodejs.org, then try again.');
  assert.equal(t.calls.length, 0);
});

test('a network failure during npm install → "Couldn\'t reach the download server…"', async () => {
  const t = make({ script: () => ({ out: 'npm error code ENOTFOUND\nnpm error network request to https://registry.npmjs.org failed\n', code: 1 }), installed: false });
  t.svc.install('codex');
  await flush();
  assert.equal(t.last('codex').message, NETWORK_FAILED);
  assert.equal(NETWORK_FAILED, "Couldn't reach the download server. Check your connection and try again.");
});

test('a second operation while one runs → busy (409 copy); cancel kills the install and frees the provider', async () => {
  const t = make({ script: () => ({ hang: true }), installed: false });
  t.svc.install('codex');
  await flush();
  assert.throws(() => t.svc.signIn('codex'), (e: unknown) => e instanceof ConnectBusyError && e.message === 'Codex is busy. Wait for it to finish or cancel it.');
  assert.throws(() => t.svc.install('codex'), ConnectBusyError);
  t.svc.install('claude'); // other providers are independent
  await flush();
  t.svc.cancel('codex');
  await flush();
  assert.equal(t.calls[0]!.killed, true);
  assert.equal(t.last('codex').phase, 'idle');
  assert.equal(t.last('codex').message, null);
  assert.equal(t.svc.busy('codex'), false);
  t.svc.cancel('claude');
  await flush();
  assert.deepEqual(t.alive(), []);
});

/** A login flow: status answers come from `signedIn()`, the login process prints a link and waits. */
function loginScript(id: 'claude' | 'codex', signedIn: () => boolean, loginOut = `If your browser did not open, navigate to this URL to authenticate: ${CODEX_URL}\n`) {
  return (_cmd: string, args: string[]): Reply => {
    if (id === 'claude' && args[0] === 'auth' && args[1] === 'status') return { out: JSON.stringify({ loggedIn: signedIn(), authMethod: 'claude.ai' }), code: signedIn() ? 0 : 1 };
    if (id === 'codex' && args[0] === 'login' && args[1] === 'status') return signedIn() ? { out: 'Logged in using ChatGPT\n' } : { out: 'Not logged in\n', code: 1 };
    if (args[0] === 'login' || (args[0] === 'auth' && args[1] === 'login')) return { out: loginOut, hang: true };
    return {};
  };
}

test('sign-in (Codex): runs `codex login`, offers the printed link, polls every 2 s, done when status flips; login process killed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signedIn = false;
  const c = make({ script: loginScript('codex', () => signedIn) });
  c.svc.signIn('codex');
  await flush();
  const login = c.calls.find((x) => is(x, 'login') && x.args.length === 1)!;
  assert.ok(login, 'codex login started');
  assert.equal(c.last('codex').phase, 'signing_in');
  assert.equal(c.last('codex').step, 'Finish signing in in your browser');
  assert.equal(c.last('codex').signInUrl, new URL(CODEX_URL).href);
  assert.deepEqual(c.opened, [], 'the tool opens the browser itself; Agent Kanban only reopens on request');
  const statuses = () => c.calls.filter((x) => is(x, 'login', 'status')).length;
  const before = statuses();
  t.mock.timers.tick(POLL_MS);
  await flush();
  assert.equal(statuses(), before + 1);
  assert.equal(c.last('codex').phase, 'signing_in');
  signedIn = true;
  t.mock.timers.tick(POLL_MS);
  await flush();
  assert.equal(c.last('codex').phase, 'idle');
  assert.equal(c.last('codex').message, null);
  assert.equal(c.last('codex').signInUrl, null);
  assert.equal(login.killed, true);
  assert.deepEqual(c.alive(), []);
  assert.deepEqual(c.checks, ['codex']);
});

test('sign-in (Claude): `claude auth login --claudeai`, status from `claude auth status --json` loggedIn', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signedIn = false;
  const url = 'https://claude.ai/oauth/authorize?code=true&client_id=x&state=y';
  const c = make({ script: loginScript('claude', () => signedIn, `Opening browser to sign in…\n\x1b[2mIf the browser didn't open, visit:\x1b[0m \x1b[4m${url}\x1b[0m\n`) });
  c.svc.signIn('claude');
  await flush();
  assert.ok(c.calls.some((x) => is(x, 'auth', 'login', '--claudeai')));
  assert.equal(c.last('claude').signInUrl, url);
  signedIn = true;
  t.mock.timers.tick(POLL_MS);
  await flush();
  assert.equal(c.last('claude').phase, 'idle');
  assert.deepEqual(c.alive(), []);
});

test('already signed in before signIn → done at once, no login process (Review Focus 5)', async () => {
  for (const id of ['claude', 'codex'] as const) {
    const c = make({ script: loginScript(id, () => true) });
    c.svc.signIn(id);
    await flush();
    assert.equal(c.last(id).phase, 'idle');
    assert.equal(c.last(id).message, null);
    assert.equal(c.calls.length, 1, 'only the status check ran');
    assert.deepEqual(c.checks, [id]);
  }
});

test('sign-in abandoned: after 5 minutes → back to signed out with the message, login process killed (Review Focus 2)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const c = make({ script: loginScript('codex', () => false) });
  c.svc.signIn('codex');
  await flush();
  for (let elapsed = 0; elapsed < SIGN_IN_TIMEOUT_MS - POLL_MS; elapsed += POLL_MS) {
    t.mock.timers.tick(POLL_MS);
    await flush(10);
  }
  assert.equal(c.last('codex').phase, 'signing_in', 'still waiting just before 5 minutes');
  t.mock.timers.tick(POLL_MS);
  await flush();
  const end = c.last('codex');
  assert.equal(end.phase, 'idle');
  assert.equal(end.message, "Sign-in didn't finish. Try again, and keep the browser window open until it says you're done.");
  assert.equal(end.message, SIGN_IN_DIDNT_FINISH);
  assert.equal(end.signInUrl, null);
  assert.ok(c.calls.find((x) => is(x, 'login') && x.args.length === 1)!.killed);
  assert.deepEqual(c.alive(), [], 'no login process left running');
  assert.equal(c.svc.busy('codex'), false);
});

test('cancel during sign-in kills the login process and returns to signed out without a message', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const c = make({ script: loginScript('codex', () => false) });
  c.svc.signIn('codex');
  await flush();
  c.svc.cancel('codex');
  await flush();
  assert.equal(c.last('codex').phase, 'idle');
  assert.equal(c.last('codex').message, null);
  assert.deepEqual(c.alive(), []);
});

test('the login process ending without a sign-in → error with the sign-in message', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const c = make({
    script: (cmd, args) => (args[0] === 'login' && args.length === 1 ? { out: 'Error: login failed\n', code: 1 } : loginScript('codex', () => false)(cmd, args)),
  });
  c.svc.signIn('codex');
  await flush();
  assert.equal(c.last('codex').phase, 'error');
  assert.equal(c.last('codex').message, SIGN_IN_DIDNT_FINISH);
});

test('"Open the browser again" opens only the captured https link', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const c = make({ script: loginScript('codex', () => false) });
  assert.throws(() => c.svc.openSignInPage('codex'), /no sign-in page/);
  c.svc.signIn('codex');
  await flush();
  c.svc.openSignInPage('codex');
  assert.deepEqual(c.opened, [new URL(CODEX_URL).href]);
  c.svc.cancel('codex');
  await flush();
});

test('findHttpsUrl: first https link, ANSI removed, trailing punctuation dropped, http ignored', () => {
  assert.equal(findHttpsUrl('visit \x1b[4mhttps://claude.ai/x?a=1&b=2\x1b[0m.'), 'https://claude.ai/x?a=1&b=2');
  assert.equal(findHttpsUrl('(https://example.com/a)'), 'https://example.com/a');
  assert.equal(findHttpsUrl('go to http://localhost:1455/callback'), null);
  assert.equal(findHttpsUrl('"https://a.example/b"'), 'https://a.example/b');
  assert.equal(findHttpsUrl('nothing here'), null);
});

test('sign out: `claude auth logout` / `codex logout`', async () => {
  for (const [id, args] of [['claude', ['auth', 'logout']], ['codex', ['logout']]] as const) {
    const c = make({ script: () => ({ out: 'Successfully logged out\n' }) });
    c.svc.signOut(id);
    await flush();
    assert.deepEqual(c.calls[0]!.args, args);
    assert.equal(c.last(id).phase, 'idle');
    assert.deepEqual(c.checks, [id]);
  }
});

// ---- Antigravity ----

function fakeAdapter(o: { url?: string; signedOut?: boolean; hang?: boolean } = {}) {
  const calls = { signIn: 0, signOut: 0, aborted: false };
  const adapter: AntigravityAuth = {
    signIn: (onUrl, signal) => {
      calls.signIn++;
      return new Promise<void>((resolve, reject) => {
        if (o.url) onUrl(o.url);
        signal.addEventListener('abort', () => { calls.aborted = true; reject(signal.reason); }, { once: true });
        if (!o.hang) resolve();
      });
    },
    signOut: async () => { calls.signOut++; return o.signedOut ?? true; },
  };
  return { adapter, calls };
}

const GOOGLE = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=http%3A%2F%2F127.0.0.1%3A5000%2F&state=s';

test('Antigravity sign-in: the adapter\'s link becomes signInUrl, the browser is not opened again (R9)', async () => {
  const { adapter, calls } = fakeAdapter({ url: GOOGLE });
  const c = make({ script: () => ({}), adapter });
  c.svc.signIn('antigravity');
  await flush();
  assert.equal(calls.signIn, 1);
  assert.deepEqual(c.opened, []);
  assert.equal(c.last('antigravity').phase, 'idle');
  assert.ok(c.updates.some((u) => u.signInUrl === GOOGLE));
  assert.deepEqual(c.checks, ['antigravity']);
});

test('Antigravity sign-in is bounded at 5 minutes by aborting the adapter (its authenticate waits a day)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { adapter, calls } = fakeAdapter({ url: GOOGLE, hang: true });
  const c = make({ script: () => ({}), adapter });
  c.svc.signIn('antigravity');
  await flush();
  assert.equal(c.last('antigravity').signInUrl, GOOGLE);
  t.mock.timers.tick(SIGN_IN_TIMEOUT_MS - 1);
  await flush();
  assert.equal(c.last('antigravity').phase, 'signing_in');
  t.mock.timers.tick(1);
  await flush();
  assert.equal(calls.aborted, true);
  assert.equal(c.last('antigravity').phase, 'idle');
  assert.equal(c.last('antigravity').message, SIGN_IN_DIDNT_FINISH);
});

test('Antigravity sign-in cancel aborts the adapter', async () => {
  const { adapter, calls } = fakeAdapter({ hang: true });
  const c = make({ script: () => ({}), adapter });
  c.svc.signIn('antigravity');
  await flush();
  c.svc.cancel('antigravity');
  await flush();
  assert.equal(calls.aborted, true);
  assert.equal(c.last('antigravity').phase, 'idle');
  assert.equal(c.last('antigravity').message, null);
});

test('Antigravity sign out: through the agent\'s logout, or the plain message when it has none', async () => {
  const yes = make({ script: () => ({}), adapter: fakeAdapter({ signedOut: true }).adapter });
  yes.svc.signOut('antigravity');
  await flush();
  assert.equal(yes.last('antigravity').phase, 'idle');
  assert.equal(yes.last('antigravity').message, null);
  const no = make({ script: () => ({}), adapter: fakeAdapter({ signedOut: false }).adapter });
  no.svc.signOut('antigravity');
  await flush();
  assert.equal(no.last('antigravity').message, 'Sign out of Antigravity in the Antigravity app.');
  assert.equal(ANTIGRAVITY_SIGN_OUT_IN_APP, 'Sign out of Antigravity in the Antigravity app.');
});

test('Antigravity install: progress steps from the installer, then the new path goes to the registry', async () => {
  const c = make({
    script: () => ({}),
    install: async (o) => {
      assert.equal(o.home, '/nonexistent-ak-home');
      o.onProgress({ phase: 'download', fraction: 0.5 });
      o.onProgress({ phase: 'verify', fraction: 1 });
      o.onProgress({ phase: 'extract', fraction: 1 });
      return { path: '/ak/1.3.0/agy_acp_server', version: '1.3.0' };
    },
  });
  c.svc.install('antigravity');
  await flush();
  const steps = [...new Set(c.updates.map((u) => u.step).filter(Boolean))];
  assert.deepEqual(steps, ['Downloading Antigravity…', 'Checking the download', 'Installing']);
  assert.equal(c.last('antigravity').phase, 'idle');
  assert.deepEqual(c.ensured, [['antigravity', '/ak/1.3.0/agy_acp_server']]);
});

test('Antigravity install failure shows the installer\'s message; cancel aborts it quietly', async () => {
  const bad = make({ script: () => ({}), install: async () => { throw new Error(DOWNLOAD_FAILED); } });
  bad.svc.install('antigravity');
  await flush();
  assert.equal(bad.last('antigravity').phase, 'error');
  assert.equal(bad.last('antigravity').message, "The download didn't finish. Try again.");

  const offline = make({ script: () => ({}), install: async () => { throw new Error(DOWNLOAD_FAILED, { cause: new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ENOTFOUND' }) }) }); } });
  offline.svc.install('antigravity');
  await flush();
  assert.equal(offline.last('antigravity').message, NETWORK_FAILED);

  let seen: AbortSignal | null = null;
  const slow = make({
    script: () => ({}),
    install: (o) => new Promise((_, reject) => { seen = o.signal; o.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }))); }),
  });
  slow.svc.install('antigravity');
  await flush();
  slow.svc.cancel('antigravity');
  await flush();
  assert.equal(seen!.aborted, true);
  assert.equal(slow.last('antigravity').phase, 'idle');
  assert.equal(slow.last('antigravity').message, null);
});

// ---- openBrowser (R6) ----

function spyOn() {
  const calls: { cmd: string; args: string[]; opts: any }[] = [];
  const spawn = ((cmd: string, args: string[], opts: any) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter() as any;
    child.unref = () => {};
    return child;
  }) as any;
  return { calls, spawn };
}

test('openBrowser: https only, never through a shell, the link is one argument', () => {
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?a=1&b=%20x&c=^|<>';
  for (const [platform, cmd] of [['win32', 'rundll32.exe'], ['darwin', 'open'], ['linux', 'xdg-open']] as const) {
    const s = spyOn();
    openBrowser(url, { platform, spawn: s.spawn });
    assert.equal(s.calls.length, 1);
    assert.equal(s.calls[0]!.cmd, cmd);
    const href = new URL(url).href;
    assert.deepEqual(s.calls[0]!.args, platform === 'win32' ? ['url.dll,FileProtocolHandler', href] : [href]);
    assert.equal(s.calls[0]!.opts.shell, false);
  }
  for (const bad of ['http://example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url', 'https://user:pw@example.com/']) {
    const s = spyOn();
    assert.throws(() => openBrowser(bad, { platform: 'win32', spawn: s.spawn }), new RegExp(ONLY_HTTPS));
    assert.equal(s.calls.length, 0);
  }
});

test('commandTarget: non-Windows paths are spawned as given', () => {
  assert.deepEqual(commandTarget('/usr/bin/npm', 'linux'), { command: '/usr/bin/npm', args: [] });
});

// ---- routes ----

test('connect routes: token required, provider validated, 202 + state, 409 when busy', async () => {
  const c = make({ script: () => ({ hang: true }), installed: false });
  const usage: any = { latest: () => [], refresh: async () => [] };
  const api = createApi({ chats: { listChats: () => [] } as any, usage, history: async () => [], token: 'tok', connect: c.svc });
  await new Promise<void>((r) => api.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  const f = (path: string, method = 'GET', token: string | null = 'tok') =>
    fetch(base + path, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} });
  try {
    assert.equal((await f('/api/connect', 'GET', null)).status, 401);
    assert.equal((await f('/api/connect/codex/install', 'POST', null)).status, 401);
    const list = await (await f('/api/connect')).json() as ConnectState[];
    assert.deepEqual(list.map((s) => s.provider), ['claude', 'codex', 'antigravity']);
    assert.equal((await f('/api/connect/gemini/install', 'POST')).status, 400);
    assert.equal((await f('/api/connect/codex/explode', 'POST')).status, 404);
    assert.equal((await f('/api/connect/codex/constructor', 'POST')).status, 404);
    const started = await f('/api/connect/codex/install', 'POST');
    assert.equal(started.status, 202);
    assert.equal((await started.json() as ConnectState).phase, 'installing');
    const busy = await f('/api/connect/codex/signin', 'POST');
    assert.equal(busy.status, 409);
    assert.deepEqual(await busy.json(), { error: 'Codex is busy. Wait for it to finish or cancel it.' });
    assert.equal((await f('/api/connect/codex/open', 'POST')).status, 409);
    const cancelled = await f('/api/connect/codex/cancel', 'POST');
    assert.equal(cancelled.status, 202);
    await flush();
    assert.equal(c.last('codex').phase, 'idle');
    assert.deepEqual(c.alive(), []);
  } finally {
    api.close(); api.server.closeAllConnections(); api.server.close();
  }
});


test('commandTarget: npm.cmd runs npm-cli.js with node (no shell)', { skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ak-npm-'));
  mkdirSync(join(dir, 'node_modules', 'npm', 'bin'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), '');
  writeFileSync(join(dir, 'npm.cmd'), '@ECHO OFF\r\nSET "NPM_CLI_JS=%~dp0\node_modules\npm\bin\npm-cli.js"\r\n"%NODE_EXE%" "%NPM_CLI_JS%" %*\r\n');
  assert.deepEqual(commandTarget(join(dir, 'npm.cmd'), 'win32'), { command: process.execPath, args: [join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')] });
});

test('spawnCommand: streams output and kill ends the process', async () => {
  const p = spawnCommand(process.execPath, ['-e', 'console.log("ready"); setInterval(() => {}, 1000)']);
  let out = '';
  p.onOutput((t) => { out += t; });
  for (let i = 0; i < 500 && !out.includes('ready'); i++) await new Promise((r) => setTimeout(r, 10));
  assert.match(out, /ready/);
  p.kill();
  const r = await p.exited;
  assert.notEqual(r.code, 0);
  const missing = await spawnCommand(join(tmpdir(), 'ak-no-such-binary-xyz'), []).exited;
  assert.equal(missing.errorCode, 'ENOENT');
});
