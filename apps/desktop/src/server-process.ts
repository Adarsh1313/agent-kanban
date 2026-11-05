// The Agent Kanban server as a child of the desktop app, run on Electron's own Node (ADR 0001). It talks to
// us over its IPC channel: `ready` / `failed` in, `stop` out. Its console output goes to a log file.
import { fork, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import type { DesktopToServer, KeyReply, KeyRequest, ServerToDesktop } from '@agent-kanban/shared';

export type StartResult = Extract<ServerToDesktop, { type: 'ready' }> | Extract<ServerToDesktop, { type: 'failed' }>;

export interface ServerProcess {
  /** The server's first message; a crash before it becomes `failed: other`. */
  started: Promise<StartResult>;
  /** Graceful stop (ends every chat); kills the server if it hasn't exited after `graceMs`. */
  stop(graceMs?: number): Promise<void>;
  /** Called once if the server exits on its own after it was ready. */
  onUnexpectedExit(listener: (code: number | null) => void): void;
}

export function startServer(opts: {
  mainPath: string; logPath: string; env?: NodeJS.ProcessEnv;
  /** Answers the server's API key requests (#43); the reply goes back over the same channel. */
  keys?: (request: KeyRequest) => KeyReply;
}): ServerProcess {
  const log = createWriteStream(opts.logPath, { flags: 'a' });
  log.write(`\n--- ${new Date().toISOString()} starting the server ---\n`);
  const child: ChildProcess = fork(opts.mainPath, [], {
    execArgv: ['--disable-warning=ExperimentalWarning'],
    env: {
      ...process.env, ...opts.env,
      // Electron's own binary runs as plain Node for the server.
      ELECTRON_RUN_AS_NODE: '1', AGENT_KANBAN_DESKTOP: '1', AGENT_KANBAN_PORT: '0', AGENT_KANBAN_OPEN_BROWSER: '',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  child.on('message', (raw) => {
    const m = raw as ServerToDesktop;
    if (m?.type !== 'keys' || !child.connected) return;
    const reply: KeyReply = opts.keys ? opts.keys(m.request) : { ok: false, error: "API keys aren't available." };
    child.send({ type: 'keys.reply', reqId: m.reqId, ...reply } satisfies DesktopToServer);
  });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });

  let stopping = false;
  let unexpected: ((code: number | null) => void) | null = null;
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => { log.end(); resolve(code); }));

  const started = new Promise<StartResult>((resolve) => {
    const first = (raw: unknown) => {
      const m = raw as ServerToDesktop;
      if (m?.type !== 'ready' && m?.type !== 'failed') return;
      child.off('message', first);
      resolve(m);
    };
    child.on('message', first);
    child.once('error', (e) => resolve({ type: 'failed', reason: 'other', message: e.message }));
    void exited.then((code) => resolve({ type: 'failed', reason: 'other', message: `The server stopped (exit code ${code}).` }));
  });
  void started.then((r) => {
    if (r.type !== 'ready') return;
    void exited.then((code) => { if (!stopping) unexpected?.(code); });
  });

  return {
    started,
    async stop(graceMs = 15_000) {
      if (child.exitCode !== null || child.signalCode !== null) return;
      stopping = true;
      if (child.connected) child.send({ type: 'stop' } satisfies DesktopToServer);
      else child.kill();
      const timer = setTimeout(() => child.kill(), graceMs);
      await exited;
      clearTimeout(timer);
    },
    onUnexpectedExit(listener) { unexpected = listener; },
  };
}
