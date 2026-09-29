import { describe, expect, it } from 'vitest';
import { createImageIntelligenceTools } from './index.js';
import { ToolManager } from '@veltravia/tool-core';
import { FileIntelligenceManager } from '@veltravia/file-intelligence-core';
import { InMemoryFileAssetStore } from '@veltravia/file-intelligence-mock';
import { ImageIntelligenceManager } from '../manager/index.js';
import { ImageProviderRegistry } from '../provider/index.js';
import { createMockImageProvider } from '@veltravia/image-intelligence-mock';

const owner = { ownerRef: 'owner-a' };

function build() {
  const files = new FileIntelligenceManager({ store: new InMemoryFileAssetStore() });
  const registry = new ImageProviderRegistry();
  registry.register(createMockImageProvider());
  const image = new ImageIntelligenceManager({ files, providers: registry });
  return { files, image };
}

describe('image tool definitions', () => {
  const { image } = build();
  const { definitions, implementations } = createImageIntelligenceTools(image, owner);

  it('defines a closed, well-formed tool set', () => {
    const ids = definitions.map((d) => d.id).sort();
    expect(ids).toEqual([
      'image.analyze',
      'image.artifact',
      'image.ask',
      'image.capabilities',
      'image.chart',
      'image.compare',
      'image.describe',
      'image.diagram',
      'image.extract',
      'image.inspect',
      'image.ocr',
      'image.screenshot',
      'image.search',
      'image.ui_structure',
    ]);
    for (const d of definitions) {
      expect(d.requiredPermissions.length).toBeGreaterThan(0);
      expect(d.inputSchema.type).toBe('object');
      expect(d.outputSchema.type).toBe('object');
      expect(d.riskLevel === 'low' || d.riskLevel === 'medium').toBe(true);
    }
    expect(implementations.map((i) => i.toolId).sort()).toEqual(ids);
  });

  it('registration grants nothing: ungranted tools are not executable', async () => {
    const { image: mgr } = build();
    const { definitions: defs } = createImageIntelligenceTools(mgr, owner);
    const manager = new ToolManager();
    for (const d of defs) manager.register(d);
    // No grants wired: every tool must be unavailable for execution.
    expect(manager.getAvailability('image.ocr').state).toBe('permission_denied');
    expect(manager.getAvailability('image.analyze').state).toBe('permission_denied');
  });

  it('permissions are read-only or process - never write scopes', () => {
    const perms = new Set(definitions.flatMap((d) => [...d.requiredPermissions]));
    for (const p of perms) expect(p.startsWith('image.')).toBe(true);
    expect(perms.has('image.read')).toBe(true);
    expect(perms.has('image.reason')).toBe(true);
    expect(perms.has('image.process')).toBe(true);
    expect(perms.has('project.write')).toBe(false);
    expect(perms.has('sandbox.execute')).toBe(false);
  });
});
