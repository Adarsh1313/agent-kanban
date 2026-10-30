// The desktop bridges for pages in the window. Sandboxed preloads must be CommonJS, so this one file is
// plain JavaScript. The web app's bridge shape is DesktopBridge in packages/shared/src/desktop.ts.
const { contextBridge, ipcRenderer } = require('electron');

// Only the local start-failure page (file:) gets the startup bridge.
if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('agentKanbanStartup', {
    retry: () => ipcRenderer.send('startup:retry'),
    quit: () => ipcRenderer.send('startup:quit'),
  });
}
