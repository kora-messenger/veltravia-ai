import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    // Development proxy: the web app calls same-origin /api and Vite
    // forwards requests to the local Veltravia AI API (no CORS involved).
    proxy: {
      '/api': {
        target: process.env.VELTRAVIA_API_PROXY_TARGET ?? 'http://localhost:3000',
        changeOrigin: false,
      },
      // Preview frames are served by the API (platform-controlled URL).
      '/preview': {
        target: process.env.VELTRAVIA_API_PROXY_TARGET ?? 'http://localhost:3000',
        changeOrigin: false,
      },
    },
  },
});
