// Manual check of Google's Antigravity agent against the REAL home folder.
//
//   node --disable-warning=ExperimentalWarning apps/server/scripts/try-antigravity.ts [--check-only] [--load <conversationId>]
//
// (a) installs Google's pinned agy_acp_server into ~/.agent-kanban/providers/antigravity if it isn't there,
// (b) starts it through the adapter and prints initialize's agentInfo / authMethods / authenticated and every
//     raw stdout/stderr text line (query values redacted), plus whether localharness_external sits next to it,
// (c) if not signed in, runs the agent's own Google sign-in: the link is printed below; open it and sign in
//     (waits up to 5 minutes; Ctrl+C cancels),
// (d) starts a chat in a NEW temp folder with "reply with the single word ok" and prints its events,
// (e) with --load <id>: tries session/load on that conversation and prints the result. It never sends a
//     message into it.
// --check-only stops after (b). Nothing here reads or prints the agent's stored credentials.
import { existsSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AntigravityAdapter, spawnAntigravity } from '../src/adapters/antigravity.ts';
import { antigravityRoot, findInstalledAntigravity, installAntigravity } from '../src/connect/antigravity-install.ts';
import { resolveAntigravityRelease } from '../src/connect/antigravity-release.ts';
import { readAntigravityHistory } from '../src/history/antigravity.ts';

const args = process.argv.slice(2);
const checkOnly = args.includes('--check-only');
const loadIdx = args.indexOf('--load');
const loadId = loadIdx >= 0 ? args[loadIdx + 1] : undefined;
if (loadIdx >= 0 && !loadId) { console.error('--load needs a conversation id'); process.exit(2); }

const home = homedir();
const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
const log = (...a: unknown[]) => console.log(ts(), ...a);
/** Query values (state, code_challenge, ...) are not shown in raw lines; the sign-in link itself is printed in full once. */
const redact = (line: string) => line.replace(/([?&][^=&\s"]+=)[^&\s"]*/g, '$1…');

// (a) install
let installed = findInstalledAntigravity(home);
if (!installed) {
  log('Antigravity is not installed: downloading Google\'s release (about 333 MB)…');
  let last = '';
  installed = await installAntigravity({
    home,
    signal: new AbortController().signal,
    onProgress: (p) => {
      const s = `${p.phase} ${Math.floor(p.fraction * 10) * 10}%`;
      if (s !== last) { last = s; log(s); }
    },
  });
}
log('agent:', installed.path, `(version folder ${installed.version})`);
const release = resolveAntigravityRelease(process.platform, process.arch);
const harnessNames = release ? [release.harness.name, `${release.harness.name}.exe`] : [];
const harness = harnessNames.map((n) => join(dirname(installed!.path), n)).find((p) => existsSync(p));
log('localharness_external next to it:', harness ?? 'NOT FOUND');

// (b) start through the adapter, echoing raw text lines
const tempDir = join(antigravityRoot(home), 'tmp');
const adapter = new AntigravityAdapter({
  exePath: installed.path,
  spawn: (cmd) => {
    const p = spawnAntigravity(cmd, tempDir);
    p.onTextLine((l) => log('[stdout text]', redact(l).slice(0, 500)));
    p.onStderrLine((l) => log('[stderr]', redact(l).slice(0, 500)));
    return p;
  },
});
adapter.onEvent((e) => log('[event]', JSON.stringify(e).slice(0, 300)));

let exitCode = 0;
try {
  log('starting the agent (it unpacks itself first; ~40 s on Windows)…');
  const ping = await adapter.ping({ manual: true });
  const init = adapter.initializeResult;
  log('initialize agentInfo:', JSON.stringify(init?.agentInfo ?? null));
  log('initialize authMethods:', JSON.stringify(init?.authMethods ?? []));
  log('initialize authenticated flag:', JSON.stringify(init?.authenticated ?? null), '(null = the agent sent none)');
  log('ping:', JSON.stringify(ping));
  if (checkOnly) throw Object.assign(new Error('done'), { quiet: true });

  // (c) sign in if needed
  if (ping.signedIn !== true) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('Sign-in didn\'t finish within 5 minutes.')), 5 * 60_000);
    process.once('SIGINT', () => ac.abort(new Error('Cancelled.')));
    log('not signed in: starting the agent\'s Google sign-in (the agent may also open your browser itself)…');
    try {
      await adapter.signIn((url) => {
        console.log('\n  Open this link and sign in with Google (it is a one-time sign-in link, not a password):\n');
        console.log(`  ${url}\n`);
      }, ac.signal);
    } finally { clearTimeout(timer); }
    log('sign-in finished. ping:', JSON.stringify(await adapter.ping({ manual: true })));
  }

  // (d) a chat in a fresh temp folder
  const cwd = mkdtempSync(join(tmpdir(), 'try-antigravity-'));
  log('chat folder:', cwd);
  const done = new Promise<void>((resolve) => adapter.onEvent((e) => {
    if (e.type === 'request.opened') { log('denying a permission request (this check runs no tools)'); void adapter.respondToRequest(e.sessionRef, e.requestId, 'deny'); }
    if (e.type === 'turn.completed' || e.type === 'stopped' || e.type === 'error') resolve();
  }));
  const { sessionRef } = await adapter.startChat({ cwd, prompt: 'reply with the single word ok' });
  log('sessionRef:', sessionRef);
  await done;

  // (e) optional session/load of an existing conversation (no message is sent into it)
  if (loadId) {
    const hist = await readAntigravityHistory(join(home, '.gemini', 'antigravity', 'conversation_summaries.db'));
    const h = hist.find((x) => x.sessionRef === loadId);
    const loadCwd = h?.cwd || cwd;
    log(`session/load ${loadId} (cwd ${loadCwd}, ${h ? 'found in history' : 'not in history'})…`);
    try { await adapter.resume(loadId, loadCwd); log('session/load: ACCEPTED'); } catch (e) { log('session/load: REJECTED:', e instanceof Error ? `${(e as any).code ?? ''} ${e.message}` : String(e)); }
  }
} catch (e) {
  if (!(e as any)?.quiet) { exitCode = 1; log('failed:', e instanceof Error ? e.message : String(e)); }
} finally {
  await adapter.dispose();
}
// Give the agent's unpacked temp folder a moment to be deleted (a later launch sweeps it otherwise).
await new Promise((r) => setTimeout(r, 3_000));
process.exit(exitCode);
