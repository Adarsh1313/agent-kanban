import { spawn as nodeSpawn } from 'node:child_process';

/**
 * A chat's "Open folder" (#15): shows a project folder in the computer's file manager. Works the same in the
 * desktop app and in browser mode, because the local server does it. The path is one argument of a fixed
 * command (no shell); the API only passes folders the board already knows.
 */
export const OPENER_UNAVAILABLE = "This computer can't open folders from Agent Kanban. Use Copy project path instead.";

export function openFolderCommand(platform: NodeJS.Platform, path: string): [string, string[]] | null {
  if (platform === 'win32') return ['explorer.exe', [path]];
  if (platform === 'darwin') return ['open', [path]];
  if (platform === 'linux') return ['xdg-open', [path]];
  return null;
}

export class FolderOpener {
  private readonly opts: { platform?: NodeJS.Platform; spawn?: typeof nodeSpawn };
  constructor(opts: FolderOpener['opts'] = {}) { this.opts = opts; }

  /** Resolves once the file manager has been started; it is never waited on. */
  open(path: string): Promise<void> {
    const cmd = openFolderCommand(this.opts.platform ?? process.platform, path);
    if (!cmd) return Promise.reject(new Error(OPENER_UNAVAILABLE));
    const spawn = this.opts.spawn ?? nodeSpawn;
    return new Promise((resolve, reject) => {
      const child = spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsHide: false });
      child.once('spawn', () => { child.unref(); resolve(); });
      child.once('error', (e: NodeJS.ErrnoException) => reject(e.code === 'ENOENT' ? new Error(OPENER_UNAVAILABLE) : e));
    });
  }
}
