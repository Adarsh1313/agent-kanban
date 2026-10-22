import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../design/tokens.css';
import '../../../design/components.css';
import '../../../design/views.css';
import './styles/app.css';
import { App } from './App.tsx';
import { initialState } from './state/reducer.ts';
import { createStore, StoreProvider } from './state/store.ts';
import { applySavedTheme } from './ui/shell/theme.ts';

applySavedTheme();
const store = createStore(initialState());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StoreProvider store={store}>
      <App />
    </StoreProvider>
  </StrictMode>,
);
