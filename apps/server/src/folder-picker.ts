import { execFile as nodeExecFile } from 'node:child_process';
import { statSync } from 'node:fs';

/**
 * Opens the computer's own folder picker for New chat's "Browse…" (#24). A browser page can't learn a folder's full
 * path, so the local server shows the native dialog and returns what was chosen. Every command is a fixed argument
 * list (no shell, nothing from the request is spliced in).
 */
export class PickerBusyError extends Error {
  constructor() { super('A folder picker is already open. Finish choosing there first.'); }
}
export const PICKER_UNAVAILABLE = "This computer can't show a folder picker. Type the folder path instead.";

type ExecFile = (cmd: string, args: string[], opts: { timeout: number; windowsHide: boolean; encoding: 'utf8' }, cb: (err: (Error & { code?: unknown }) | null, stdout: string) => void) => unknown;

// The dialog gets an invisible top-most owner window, so it opens in front of the browser instead of behind it.
const WINDOWS_SCRIPT = [
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Windows.Forms',
  '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; WindowState = "Minimized" }',
  '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
  '$d.Description = "Choose a folder for Agent Kanban"',
  '$d.ShowNewFolderButton = $true',
  'if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }',
  '$owner.Dispose()',
].join('; ');

export function pickerCommand(platform: NodeJS.Platform): [string, string[]] | null {
  if (platform === 'win32') return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', WINDOWS_SCRIPT]];
  if (platform === 'darwin') return ['osascript', ['-e', 'POSIX path of (choose folder with prompt "Choose a folder for Agent Kanban")']];
  if (platform === 'linux') return ['zenity', ['--file-selection', '--directory', '--title=Choose a folder for Agent Kanban']];
  return null;
}

export class FolderPicker {
  private open = false;
  private readonly opts: { platform?: NodeJS.Platform; execFile?: ExecFile; timeoutMs?: number; isDir?: (p: string) => boolean };
  constructor(opts: FolderPicker['opts'] = {}) { this.opts = opts; }

  /** The chosen folder, or null when the picker was cancelled. */
  async pick(): Promise<string | null> {
    if (this.open) throw new PickerBusyError();
    const cmd = pickerCommand(this.opts.platform ?? process.platform);
    if (!cmd) throw new Error(PICKER_UNAVAILABLE);
    const execFile = this.opts.execFile ?? (nodeExecFile as unknown as ExecFile);
    const isDir = this.opts.isDir ?? ((p) => { try { return statSync(p).isDirectory(); } catch { return false; } });
    this.open = true;
    try {
      const out = await new Promise<string | null>((resolve, reject) => {
        // Inside the desktop app the server has no console, so PowerShell would open a visible one: hide it
        // (the dialog itself still shows). In browser mode it shares the server's terminal, as before.
        execFile(cmd[0], cmd[1], { timeout: this.opts.timeoutMs ?? 10 * 60_000, windowsHide: !!process.versions.electron, encoding: 'utf8' }, (err, stdout) => {
          if (!err) return resolve(stdout);
          // osascript and zenity exit with 1 when the user cancels.
          if (typeof err.code === 'number' && err.code === 1) return resolve(null);
          reject(err.code === 'ENOENT' ? new Error(PICKER_UNAVAILABLE) : err);
        });
      });
      const path = out?.replace(/[\r\n]+$/, '').replace(/(.)[\\/]$/, '$1') ?? '';
      return path && isDir(path) ? path : null;
    } finally {
      this.open = false;
    }
  }
}
