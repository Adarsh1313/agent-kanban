// Agent Kanban desktop app: Electron's main process. It owns the window, the tray and the server child
// process; it holds no chat logic. Spec: docs/specs/desktop-app.md; look: design/DESIGN.md (Desktop app).
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, safeStorage, screen, shell, Tray, type IpcMainEvent, type MenuItemConstructorOptions } from 'electron';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DesktopStatus } from '@agent-kanban/shared';
import { KeyFile } from './keys.ts';
import { restorePlacement, type Placement } from './placement.ts';
import { startServer, type ServerProcess, type StartResult } from './server-process.ts';
import { loadState, noteFirstClose, saveState } from './state.ts';
import { quitPrompt, trayIcon, trayMenu, trayTooltip } from './tray.ts';

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, '..', 'assets');
// The same data folder the server uses (browser mode too): one set of chats, one running at a time.
const akHome = process.env.AGENT_KANBAN_HOME ? resolve(process.env.AGENT_KANBAN_HOME) : homedir();
const dataDir = join(akHome, '.agent-kanban');
mkdirSync(dataDir, { recursive: true });
const statePath = join(dataDir, 'desktop.json');
const state = loadState(statePath);
// The user's own API keys (#43), encrypted with the operating system's key store. Only this process reads them.
const keyFile = new KeyFile({
  path: join(dataDir, 'keys.json'),
  cipher: {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (cipher) => safeStorage.decryptString(cipher),
  },
});
// Started by Windows at sign-in: stay in the tray until the user opens the window.
const startHidden = process.argv.includes('--hidden');

// Mirror design/tokens.css: --color-bg (the window behind the page, so it never flashes white),
// --titlebar-symbol (Windows' caption buttons) and --titlebar-height.
const BG = { light: '#fbfbfa', dark: '#121213' };
const SYMBOL = { light: '#6e6e6a', dark: '#9a9a96' };
const TITLEBAR_HEIGHT = 48;
const overlay = (theme: 'light' | 'dark') => ({ color: BG[theme], symbolColor: SYMBOL[theme], height: TITLEBAR_HEIGHT });
const systemTheme = () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light');

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let server: ServerProcess | null = null;
let origin = '';
let quitting = false;
let status: DesktopStatus = { needsYou: [], running: 0 };

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

function createWindow(): BrowserWindow {
  const placement = restorePlacement(state.placement, [screen.getPrimaryDisplay(), ...screen.getAllDisplays()].map((d) => d.workArea));
  const w = new BrowserWindow({
    x: placement.x, y: placement.y, width: placement.width, height: placement.height,
    minWidth: 720, minHeight: 480,
    show: false,
    title: 'Agent Kanban',
    icon: join(assets, 'icon.ico'),
    backgroundColor: BG[systemTheme()],
    // The page's top bar is the title bar; Windows still draws its own caption buttons over it.
    titleBarStyle: 'hidden',
    titleBarOverlay: overlay(systemTheme()),
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
  win = w;
  w.setMenu(null);
  if (placement.maximized) w.maximize();
  w.once('ready-to-show', () => { if (!startHidden) showWindow(); });

  // The window only ever shows Agent Kanban; every other link opens in the default browser.
  w.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/.test(target)) void shell.openExternal(target);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e, target) => {
    if (URL.canParse(target) && new URL(target).origin === origin) return;
    e.preventDefault();
    if (/^https?:/.test(target)) void shell.openExternal(target);
  });

  let saveTimer: NodeJS.Timeout | undefined;
  const queueSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(savePlacement, 400); };
  w.on('resize', queueSave);
  w.on('move', queueSave);
  // Closing hides to the tray: chats keep running. Only Quit (tray menu) ends the app.
  w.on('close', (e) => {
    savePlacement();
    if (quitting) return;
    e.preventDefault();
    w.hide();
    if (noteFirstClose(state)) {
      saveState(statePath, state);
      new Notification({ title: 'Agent Kanban is still running', body: 'Quit it from the tray icon.', icon: join(assets, 'icon.png') }).show();
    }
  });
  // Windows is signing out or shutting down: let the window close.
  w.on('session-end', () => { quitting = true; });
  w.on('closed', () => { win = null; });
  return w;
}

/* ───────── Tray ───────── */

const startAtLogin = () => app.getLoginItemSettings(loginItemOptions()).openAtLogin;
// In development the app is electron.exe plus the app folder; packaged, it is the app's own exe.
const loginItemOptions = () => ({ path: process.execPath, args: [...(app.isPackaged ? [] : [app.getAppPath()]), '--hidden'] });

function openChatFromTray(chatId: string): void {
  showWindow();
  win?.webContents.send('desktop:open-chat', chatId);
}

function updateTray(): void {
  if (!tray) return;
  tray.setImage(nativeImage.createFromPath(join(assets, `${trayIcon(status, nativeTheme.shouldUseDarkColorsForSystemIntegratedUI)}.png`)));
  tray.setToolTip(trayTooltip(status));
  const template: MenuItemConstructorOptions[] = trayMenu(status, startAtLogin()).map((item): MenuItemConstructorOptions => {
    switch (item.kind) {
      case 'open': return { label: item.label, click: showWindow };
      case 'heading': return { label: item.label, enabled: false };
      case 'chat': return { label: item.label, click: () => openChatFromTray(item.id) };
      case 'more': return { label: item.label, click: showWindow };
      case 'separator': return { type: 'separator' };
      case 'login': return { label: item.label, type: 'checkbox', checked: item.checked, click: (m) => {
        app.setLoginItemSettings({ ...loginItemOptions(), openAtLogin: m.checked });
        updateTray();
      } };
      case 'quit': return { label: item.label, click: () => void requestQuit() };
    }
  });
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

/** Quit from the tray: asks first while chats are running, then stops the server and every chat. */
async function requestQuit(): Promise<void> {
  const prompt = quitPrompt(status.running);
  if (prompt) {
    const options = { type: 'question' as const, title: 'Agent Kanban', message: prompt.message, detail: prompt.detail, buttons: prompt.buttons, defaultId: 1, cancelId: 1, noLink: true };
    const { response } = win && win.isVisible() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    if (response !== 0) return;
  }
  app.quit();
}

/* ───────── Server ───────── */

function showStartFailed(reason: Extract<StartResult, { type: 'failed' }>['reason']): void {
  origin = '';
  status = { needsYou: [], running: 0 };
  updateTray();
  const w = win ?? createWindow();
  // Shown even after a start at sign-in (--hidden): a failure must never leave only a tray icon.
  void w.loadFile(join(here, 'start-failed.html'), { query: { reason } }).then(showWindow);
}

/** Starts the server and loads the board, or the start-failure page if it can't start. */
async function launch(): Promise<void> {
  server = startServer({ mainPath: join(here, '..', '..', 'server', 'src', 'main.ts'), logPath: join(dataDir, 'desktop.log'), keys: (r) => keyFile.handle(r) });
  const result = await server.started;
  if (result.type !== 'ready') {
    server = null;
    showStartFailed(result.reason);
    return;
  }
  origin = `http://127.0.0.1:${result.port}`;
  server.onUnexpectedExit(() => { server = null; if (!quitting) showStartFailed('other'); });
  void (win ?? createWindow()).loadURL(`${origin}/?token=${result.token}`);
}

/** Only the board in our own window may use the bridge. */
const fromBoard = (e: IpcMainEvent) => !!win && e.sender === win.webContents && !!origin && e.senderFrame?.origin === origin;

ipcMain.on('desktop:status', (e, next: DesktopStatus) => {
  if (!fromBoard(e) || !next || !Array.isArray(next.needsYou) || !Number.isInteger(next.running)) return;
  status = { needsYou: next.needsYou.map((c) => ({ id: String(c.id), title: String(c.title) })), running: next.running };
  updateTray();
});
ipcMain.on('desktop:show', (e) => { if (fromBoard(e)) showWindow(); });
ipcMain.on('desktop:theme', (e, theme: unknown) => {
  if (!fromBoard(e) || (theme !== 'light' && theme !== 'dark') || !win) return;
  win.setTitleBarOverlay(overlay(theme));
  win.setBackgroundColor(BG[theme]);
});
// Buttons on the start-failure page.
ipcMain.on('startup:retry', (e) => { if (!server && e.sender === win?.webContents) void launch(); });
ipcMain.on('startup:quit', () => app.quit());

if (!app.requestSingleInstanceLock()) {
  // Another copy is running: it brings its window forward (second-instance below), and this one leaves.
  app.quit();
} else {
  app.setAppUserModelId('com.agentkanban.desktop');
  app.on('second-instance', showWindow);
  // The window hides rather than closes; the app lives on in the tray until Quit.
  app.on('window-all-closed', () => {});
  app.on('before-quit', (e) => {
    quitting = true;
    if (!server) return;
    // Stop the server (and every chat) cleanly before the app goes.
    e.preventDefault();
    const stopping = server;
    server = null;
    void stopping.stop().finally(() => app.quit());
  });
  void app.whenReady().then(() => {
    tray = new Tray(nativeImage.createFromPath(join(assets, 'tray-on-dark.png')));
    tray.on('click', showWindow);
    nativeTheme.on('updated', updateTray);
    updateTray();
    return launch();
  });
}
