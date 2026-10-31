// Builds the Windows installer: npm run desktop:dist → apps/desktop/dist/Agent Kanban Setup <version>.exe
//
// The app runs from TypeScript sources (ADR 0001), and Node never strips types from files under node_modules.
// So the workspaces can't be packaged as installed packages: this script stages a flat app folder instead,
//   stage/apps/{desktop,server,web/dist}, stage/packages/shared, stage/design/tokens.css
// whose package.json names itself @agent-kanban/shared with that package's exports. Imports of
// '@agent-kanban/shared' then resolve to stage/packages/shared/src (a package importing its own name), outside
// node_modules. Only the server's runtime dependencies are installed into stage/node_modules.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const desktop = join(root, 'apps', 'desktop');
const stage = join(desktop, 'stage');
const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const run = (cmd: string, args: string[], cwd: string) =>
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });

const desktopPkg = readJson(join(desktop, 'package.json'));
const serverPkg = readJson(join(root, 'apps', 'server', 'package.json'));
const sharedPkg = readJson(join(root, 'packages', 'shared', 'package.json'));
const electronVersion = readJson(join(root, 'node_modules', 'electron', 'package.json')).version;

console.log('Building the web app…');
run('npm', ['run', 'build:web'], root);

console.log('Staging the app…');
rmSync(stage, { recursive: true, force: true });
const copy = (from: string, to = from) => cpSync(join(root, from), join(stage, to), { recursive: true, filter: (src) => !/[\\/](test|stage|dist|scripts)([\\/]|$)/.test(src.slice(join(root, from).length)) });
copy('apps/desktop/src');
copy('apps/desktop/assets');
copy('apps/server/src');
cpSync(join(root, 'apps', 'web', 'dist'), join(stage, 'apps', 'web', 'dist'), { recursive: true });
copy('packages/shared/src');
mkdirSync(join(stage, 'design'), { recursive: true });
cpSync(join(root, 'design', 'tokens.css'), join(stage, 'design', 'tokens.css'));

const runtimeDeps = Object.fromEntries(Object.entries(serverPkg.dependencies as Record<string, string>).filter(([name]) => !name.startsWith('@agent-kanban/') && !name.startsWith('@types/')));
writeFileSync(join(stage, 'package.json'), JSON.stringify({
  // Named after the shared package so its imports resolve here, outside node_modules (see the top of this file).
  name: sharedPkg.name,
  productName: 'Agent Kanban',
  version: desktopPkg.version,
  description: 'Every AI coding chat as a card on a Kanban board.',
  author: 'Agent Kanban',
  private: true,
  type: 'module',
  main: 'apps/desktop/src/main.ts',
  exports: { '.': './packages/shared/src/types.ts' },
  dependencies: runtimeDeps,
}, null, 2));

console.log('Installing the server\'s runtime dependencies…');
// --omit=optional leaves out the Agent SDK's bundled Claude binary (~280 MB): the server always runs the user's
// own `claude` (pathToClaudeCodeExecutable), as each provider runs on its official, user-installed harness.
run('npm', ['install', '--omit=dev', '--omit=optional', '--no-fund', '--no-audit', '--no-package-lock'], stage);

console.log('Building the installer…');
run('npx', ['electron-builder', '--win', 'nsis', '--x64', '--projectDir', stage, '--config', join(desktop, 'electron-builder.json'),
  `--config.electronVersion=${electronVersion}`, `--config.directories.output=${join(desktop, 'dist')}`], root);
