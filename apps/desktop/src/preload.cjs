// The desktop bridges for pages in the window. Sandboxed preloads must be CommonJS, so this one file is
// plain JavaScript. The web app's bridge shape is DesktopBridge in packages/shared/src/desktop.ts.
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'file:') {
  // The local start-failure page.
  contextBridge.exposeInMainWorld('agentKanbanStartup', {
    retry: () => ipcRenderer.send('startup:retry'),
    quit: () => ipcRenderer.send('startup:quit'),
  });
} else if (location.protocol === 'http:' && location.hostname === '127.0.0.1') {
  // The web app, served by our own server. The main process also checks who is calling.
  contextBridge.exposeInMainWorld('agentKanbanDesktop', {
    status: (status) => ipcRenderer.send('desktop:status', status),
    show: () => ipcRenderer.send('desktop:show'),
    theme: (theme) => ipcRenderer.send('desktop:theme', theme),
    onOpenChat: (listener) => {
      const handler = (_event, chatId) => listener(chatId);
      ipcRenderer.on('desktop:open-chat', handler);
      return () => ipcRenderer.removeListener('desktop:open-chat', handler);
    },
  });
}
