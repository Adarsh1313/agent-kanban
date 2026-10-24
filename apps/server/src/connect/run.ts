// Runs the official installers and sign-in commands for ConnectService: never through a shell, no window,
// and cancel kills the whole process tree.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { resolveSpawnTarget } from '../adapters/spawn-target.ts';
import { killTree } from '../adapters/jsonrpc.ts';

export interface CommandExit {
  /** The exit code; null when it was killed or couldn't start. */
  code: number | null;
  /** Set when the command couldn't be started (e.g. ENOENT, EACCES). */
  errorCode?: string;
}

export interface RunningCommand {
  /** stdout and stderr text, as it arrives. */
  onOutput(fn: (text: string) => void): void;
  /** Resolves once the process has exited (never rejects). */
  readonly exited: Promise<CommandExit>;
  /** Kills the process and everything it started. */
  kill(): void;
}

export type CommandRunner = (command: string, args: string[]) => RunningCommand;

const EXIT_GRACE_MS = 200;
const KILL_ESCALATE_MS = 3_000;

/**
 * What to spawn for `file`: npm-style .cmd shims are resolved to the program they launch (Node can't spawn
 * a .cmd without a shell). npm's own shim (`%~dp0\node_modules\npm\bin\npm-cli.js`) has its own form.
 */
export function commandTarget(file: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  const t = resolveSpawnTarget(file, platform);
  if (platform !== 'win32' || t.command !== file || !/\.cmd$/i.test(file)) return t;
  const dir = path.win32.dirname(file);
  const cli = path.win32.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (path.win32.basename(file).toLowerCase() === 'npm.cmd' && existsSync(cli)) {
    const node = path.win32.join(dir, 'node.exe');
    return { command: existsSync(node) ? node : process.execPath, args: [cli] };
  }
  return t;
}

function killGroup(child: ChildProcess): void {
  if (process.platform === 'win32') return killTree(child);
  const pid = child.pid;
  try {
    if (pid !== undefined) process.kill(-pid, 'SIGTERM'); // the child leads its own process group (detached)
    else child.kill('SIGTERM');
  } catch {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }
}

/** The real CommandRunner. */
export const spawnCommand: CommandRunner = (command, args) => {
  const target = commandTarget(command);
  const fns: Array<(t: string) => void> = [];
  let child: ChildProcess;
  let resolveExit!: (e: CommandExit) => void;
  const exited = new Promise<CommandExit>((r) => { resolveExit = r; });
  let done = false;
  const finish = (e: CommandExit) => { if (!done) { done = true; resolveExit(e); } };
  try {
    child = spawn(target.command, [...target.args, ...args], {
      shell: false,
      windowsHide: true,
      // stdin stays open (nothing is written): some sign-in flows stop when it closes.
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
  } catch (e) {
    finish({ code: null, errorCode: (e as NodeJS.ErrnoException).code ?? 'ESPAWN' });
    return { onOutput: () => {}, exited, kill: () => {} };
  }
  const emit = (b: Buffer) => { const t = b.toString('utf8'); for (const fn of fns) { try { fn(t); } catch { /* listener bug */ } } };
  child.stdout?.on('data', emit);
  child.stderr?.on('data', emit);
  child.stdin?.on('error', () => {});
  child.on('error', (e: NodeJS.ErrnoException) => finish({ code: null, errorCode: e.code ?? 'ESPAWN' }));
  child.on('close', (code) => finish({ code }));
  // A grandchild can hold the pipes open: 'exit' finishes the job if 'close' doesn't come.
  child.on('exit', (code) => { setTimeout(() => finish({ code }), EXIT_GRACE_MS).unref(); });
  let killed = false;
  return {
    onOutput: (fn) => { fns.push(fn); },
    exited,
    kill: () => {
      if (done || killed) return;
      killed = true;
      killGroup(child);
      if (process.platform !== 'win32') {
        const t = setTimeout(() => {
          if (done) return;
          try { if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
        }, KILL_ESCALATE_MS);
        t.unref();
      }
    },
  };
};
