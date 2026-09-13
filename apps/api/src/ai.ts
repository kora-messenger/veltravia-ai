import { AICore, loadAIConfig } from '@veltravia/ai-core';
import { MockAIProvider, createMockModels } from '@veltravia/ai-provider-mock';

/**
 * Builds the API's AICore instance. Step 2 wires ONLY the mock provider -
 * real provider adapters arrive in a later step and will slot in here
 * without touching any other code.
 *
 * Only routing/limit configuration is read from the environment. Secrets
 * (real API keys) will be bound inside future provider adapters via the
 * secret manager - never here.
 */
export function createAICore(now: () => Date = () => new Date()): AICore {
  const core = new AICore({
    providers: [new MockAIProvider({ now })],
    config: loadAIConfig(),
  });
  core.registry.registerModels(createMockModels());
  return core;
}
