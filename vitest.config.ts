import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Vitest resolves workspace packages straight from their TypeScript sources,
 * so tests never require a prior build step.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@veltravia/types': r('./packages/types/src/index.ts'),
      '@veltravia/shared': r('./packages/shared/src/index.ts'),
      '@veltravia/config': r('./packages/config/src/index.ts'),
      '@veltravia/ai-core': r('./ai/core/src/index.ts'),
      '@veltravia/ai-provider-mock': r('./ai/providers/mock/src/index.ts'),
      '@veltravia/api': r('./apps/api/src/server.ts'),
    },
  },
  test: {
    environment: 'node',
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      'ai/**/src/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
  },
});
