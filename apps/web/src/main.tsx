import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { loadRuntimeConfig } from './config/runtime-config';
import './design/fonts.css';
import './design/tokens.css';
import './design/global.css';
import './components/ui/ui.css';
import './components/brand/brand.css';
import './shell/shell.css';
import './shell/mobile-drawer.css';
import './pages/pages.css';
import './pages/chat/chat.css';
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
  // The static first-paint frame in index.html lives inside #root, so the first React
  // commit replaces it. Its stylesheet only styles that frame, so it goes once the real
  // page is on screen: removed in the frame after the commit, never before it, or the
  // frame would lose its styling for a moment and flash unstyled.
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => document.querySelector('style[data-boot]')?.remove());
  });
});
