import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../design/tokens.css';
import '../../../design/components.css';
import '../../../design/views.css';
import './styles/app.css';
import { App } from './App.tsx';
import { desktopBridge, startDesktopSync, startDesktopWindow } from './desktop.ts';
import { initialState } from './state/reducer.ts';
import { createStore, StoreProvider } from './state/store.ts';
import { startNotifier } from './ui/notify/notifier.ts';
import { applySavedTheme } from './ui/shell/theme.ts';

applySavedTheme();
const store = createStore(initialState());
startNotifier(store);
// Inside the desktop app: keep the tray current and make the top bar the title bar.
const desktop = desktopBridge();
if (desktop) {
  startDesktopSync(store, desktop);
  startDesktopWindow(desktop);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StoreProvider store={store}>
      <App />
    </StoreProvider>
  </StrictMode>,
);
