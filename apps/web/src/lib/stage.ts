import { VELTRAVIA_NAME, VELTRAVIA_VERSION } from '@veltravia/types';

/** Human-readable label for the current platform development stage. */
export function stageLabel(): string {
  return `${VELTRAVIA_NAME} v${VELTRAVIA_VERSION} - Step 1: Foundation`;
}
