import { describe, expect, it } from 'vitest';
import { VELTRAVIA_NAME, VELTRAVIA_VERSION } from '@veltravia/types';
import { stageLabel } from './stage';

describe('stageLabel', () => {
  it('describes the current foundation stage', () => {
    expect(stageLabel()).toBe(`${VELTRAVIA_NAME} v${VELTRAVIA_VERSION} - Step 1: Foundation`);
  });
});
