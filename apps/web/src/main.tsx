import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../design/tokens.css';
import '../../../design/components.css';
import '../../../design/views.css';
import './styles/app.css';
import { App } from './App.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
