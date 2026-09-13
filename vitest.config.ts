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
      '@veltravia/ai-provider-gemini': r('./ai/providers/gemini/src/index.ts'),
      '@veltravia/connector-core': r('./connectors/core/src/index.ts'),
      '@veltravia/connector-mock': r('./connectors/mock/src/index.ts'),
      '@veltravia/tool-core': r('./tools/core/src/index.ts'),
      '@veltravia/tool-mock': r('./tools/mock/src/index.ts'),
      '@veltravia/agent-core': r('./agent/core/src/index.ts'),
      '@veltravia/agent-mock': r('./agent/mock/src/index.ts'),
      '@veltravia/project-core': r('./project-engine/core/src/index.ts'),
      '@veltravia/project-mock': r('./project-engine/mock/src/index.ts'),
      '@veltravia/sandbox-core': r('./security/sandbox/src/index.ts'),
      '@veltravia/sandbox-mock': r('./security/sandbox-mock/src/index.ts'),
      '@veltravia/api': r('./apps/api/src/server.ts'),
    },
  },
  test: {
    environment: 'node',
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      'ai/**/src/**/*.test.ts',
      'connectors/**/src/**/*.test.ts',
      'tools/**/src/**/*.test.ts',
      'agent/**/src/**/*.test.ts',
      'project-engine/**/src/**/*.test.ts',
      'security/**/src/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
  },
});
