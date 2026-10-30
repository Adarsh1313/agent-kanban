// Puts "Agent Kanban" and "Stop Agent Kanban" shortcuts on the Windows desktop. Run once: `npm run desktop:install`.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  console.log('Desktop shortcuts are Windows-only for now. Start Agent Kanban with `npm run desktop`.');
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const shortcuts = [
  { name: 'Agent Kanban', script: join(here, 'start.mjs'), description: 'Start Agent Kanban and open it in your browser', window: 7 },
  { name: 'Stop Agent Kanban', script: join(here, 'stop.mjs'), description: 'Stop Agent Kanban', window: 1 },
];
// Values go to PowerShell as environment variables, never spliced into the script text.
const ps = [
  '$shell = New-Object -ComObject WScript.Shell',
  '$desktop = [Environment]::GetFolderPath("Desktop")',
  '$s = $shell.CreateShortcut((Join-Path $desktop ($env:AK_NAME + ".lnk")))',
  '$s.TargetPath = $env:AK_NODE',
  '$s.Arguments = \'"\' + $env:AK_SCRIPT + \'"\'',
  '$s.WorkingDirectory = $env:AK_ROOT',
  '$s.Description = $env:AK_DESC',
  '$s.WindowStyle = [int]$env:AK_WINDOW',
  '$s.Save()',
].join('; ');
for (const s of shortcuts) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    stdio: 'inherit',
    env: { ...process.env, AK_NAME: s.name, AK_NODE: process.execPath, AK_SCRIPT: s.script, AK_ROOT: root, AK_DESC: s.description, AK_WINDOW: String(s.window) },
  });
  if (r.status !== 0) { console.error(`Couldn't create the "${s.name}" shortcut.`); process.exit(1); }
  console.log(`Added "${s.name}" to your desktop.`);
}
