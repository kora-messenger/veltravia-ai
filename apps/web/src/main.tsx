import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { loadRuntimeConfig } from './config/runtime-config';
import './design/tokens.css';
import './design/global.css';
import './components/ui/ui.css';
import './components/brand/brand.css';
import './shell/shell.css';
import './pages/pages.css';
import './pages/workspace/workspace.css';
import './pages/builder/builder.css';
import './pages/backend/backend.css';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element #root not found');

// The backend location is read once, before the first request, so no screen can
// fire at the wrong origin while the configuration is still loading.
void loadRuntimeConfig().then(() => {
  createRoot(rootElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
