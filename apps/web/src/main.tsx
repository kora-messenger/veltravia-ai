import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './design/tokens.css';
import './design/global.css';
import './components/ui/ui.css';
import './shell/shell.css';
import './pages/pages.css';
import './pages/workspace/workspace.css';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element #root not found');

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
