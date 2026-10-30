// Agent Kanban desktop app: Electron's main process. It owns the window, the server child process and
// (later) the tray; it holds no chat logic. Spec: docs/specs/desktop-app.md.
import { app, BrowserWindow, nativeTheme, screen, shell } from 'electron';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { restorePlacement, type Placement } from './placement.ts';
import { startServer, type ServerProcess } from './server-process.ts';
import { loadState, saveState } from './state.ts';

const here = dirname(fileURLToPath(import.meta.url));
// The same data folder the server uses (browser mode too): one set of chats, one running at a time.
const akHome = process.env.AGENT_KANBAN_HOME ? resolve(process.env.AGENT_KANBAN_HOME) : homedir();
const dataDir = join(akHome, '.agent-kanban');
mkdirSync(dataDir, { recursive: true });
const statePath = join(dataDir, 'desktop.json');
const state = loadState(statePath);

// Mirrors --color-bg in design/tokens.css, so the window never flashes white before the page paints.
const BG = { light: '#fbfbfa', dark: '#121213' };

let win: BrowserWindow | null = null;
let server: ServerProcess | null = null;
let origin = '';
let quitting = false;

function showWindow(): void {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function savePlacement(): void {
  if (!win || win.isMinimized()) return;
  const b = win.getNormalBounds();
  state.placement = { ...b, maximized: win.isMaximized() } satisfies Placement;
  saveState(statePath, state);
}

function createWindow(url: string): void {
  const placement = restorePlacement(state.placement, [screen.getPrimaryDisplay(), ...screen.getAllDisplays()].map((d) => d.workArea));
  win = new BrowserWindow({
    x: placement.x, y: placement.y, width: placement.width, height: placement.height,
    minWidth: 720, minHeight: 480,
    show: false,
    title: 'Agent Kanban',
    backgroundColor: nativeTheme.shouldUseDarkColors ? BG.dark : BG.light,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Keeps the page (and so the tray's needs-you list) current while the window is hidden.
      backgroundThrottling: false,
    },
  });
  win.setMenu(null);
  if (placement.maximized) win.maximize();
  win.once('ready-to-show', showWindow);

  // The window only ever shows Agent Kanban; every other link opens in the default browser.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/.test(target)) void shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, target) => {
    if (new URL(target).origin === origin) return;
    e.preventDefault();
    if (/^https?:/.test(target)) void shell.openExternal(target);
  });

  let saveTimer: NodeJS.Timeout | undefined;
  const queueSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(savePlacement, 400); };
  win.on('resize', queueSave);
  win.on('move', queueSave);
  win.on('close', savePlacement);
  win.on('closed', () => { win = null; });

  void win.loadURL(url);
}

async function launch(): Promise<void> {
  server = startServer({ mainPath: join(here, '..', '..', 'server', 'src', 'main.ts'), logPath: join(dataDir, 'desktop.log') });
  const result = await server.started;
  if (result.type !== 'ready') {
    // Replaced by the start-failure page in the next slice.
    console.error(result.message);
    app.quit();
    return;
  }
  origin = `http://127.0.0.1:${result.port}`;
  server.onUnexpectedExit(() => { if (!quitting) app.quit(); });
  createWindow(`${origin}/?token=${result.token}`);
}

if (!app.requestSingleInstanceLock()) {
  // Another copy is running: it brings its window forward (second-instance below), and this one leaves.
  app.quit();
} else {
  app.setAppUserModelId('com.agentkanban.desktop');
  app.on('second-instance', showWindow);
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (e) => {
    if (quitting || !server) return;
    // Stop the server (and every chat) cleanly before the app goes.
    e.preventDefault();
    quitting = true;
    void server.stop().finally(() => app.quit());
  });
  void app.whenReady().then(launch);
}
