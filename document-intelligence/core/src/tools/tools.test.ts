import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FileIntelligenceManager, asFileAssetId } from '@veltravia/file-intelligence-core';
import { InMemoryFileAssetStore } from '@veltravia/file-intelligence-mock';
import { ToolManager } from '@veltravia/tool-core';
import { DocumentIntelligenceManager } from '../manager/index.js';
import { DocumentProviderRegistry } from '../provider/index.js';
import { createDocumentIntelligenceTools } from './index.js';
import { createMockDocumentProvider } from '@veltravia/document-intelligence-mock';

const read = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url))));
const scope = { ownerRef: 'owner-a', projectId: 'p1', workspaceId: 'w1' };
const principal = { ownerRef: 'owner-a' };
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const EXPECTED_IDS = [
  'document.ask',
  'document.compare',
  'document.entities',
  'document.get_job',
  'document.inspect',
  'document.memory_candidates',
  'document.ocr',
  'document.presentation_view',
  'document.process',
  'document.search',
  'document.semantic_search',
  'document.spreadsheet_view',
  'document.structure',
  'document.summarize',
];

async function harness(granted = true) {
  const files = new FileIntelligenceManager({
    store: new InMemoryFileAssetStore(),
    now: () => new Date('2026-10-01T08:00:00Z'),
  });
  const providers = new DocumentProviderRegistry();
  providers.register(createMockDocumentProvider());
  const documents = new DocumentIntelligenceManager({ files, providers });
  const { definitions, implementations } = createDocumentIntelligenceTools(documents, principal);
  const manager = new ToolManager({ now: () => new Date('2026-10-01T08:00:00Z') });
  for (const definition of definitions) manager.register(definition);
  for (const implementation of implementations) manager.registerImplementation(implementation);
  if (granted) {
    for (const definition of definitions)
      for (const permission of definition.requiredPermissions)
        manager.grantPermission(definition.id, permission);
  }
  const file = await files.registerFile({
    filename: 'report.docx',
    bytes: read('report.docx'),
    declaredMimeType: DOCX_MIME,
    source: 'user_upload',
    scope,
  });
  return { manager, definitions, implementations, fileId: asFileAssetId(file.id) };
}

describe('Document Intelligence tools', () => {
  it('defines a closed set of 14 read-only tools', async () => {
    const { definitions, implementations } = await harness();
    expect(definitions.map((d) => d.id).sort()).toEqual(EXPECTED_IDS);
    expect(implementations.map((i) => i.toolId).sort()).toEqual(EXPECTED_IDS);
    for (const definition of definitions) {
      expect(definition.requiredPermissions.length).toBeGreaterThan(0);
      expect(definition.inputSchema.type).toBe('object');
      expect(definition.outputSchema.type).toBe('object');
      expect(definition.requiresConfirmation).toBe(false);
      expect(['low', 'medium']).toContain(definition.riskLevel);
    }
  });

  it('only declares read and reason scopes, never write scopes', async () => {
    const { definitions } = await harness();
    const permissions = new Set(definitions.flatMap((d) => [...d.requiredPermissions]));
    expect(permissions.has('document.read')).toBe(true);
    expect(permissions.has('document.reason')).toBe(true);
    expect(permissions.has('project.write')).toBe(false);
    expect(permissions.has('sandbox.execute')).toBe(false);
  });

  it('registration grants nothing until permissions are granted', async () => {
    const { manager } = await harness(false);
    expect(manager.getAvailability('document.inspect').state).toBe('permission_denied');
    expect(manager.getAvailability('document.ask').state).toBe('permission_denied');
  });

  it('inspects a real document through the Tool System pipeline', async () => {
    const { manager, fileId } = await harness();
    const result = await manager.invoke(
      'document.inspect',
      { fileId },
      { requester: 'test-harness' },
    );
    const output = result.output as { format: string; simulated: boolean; trustTag?: string };
    expect(output.format).toBe('docx');
    expect(output.simulated).toBe(true);
  });

  it('fails closed on malformed input', async () => {
    const { manager } = await harness();
    const result = await manager.invoke(
      'document.ask',
      { fileId: '' },
      { requester: 'test-harness' },
    );
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('INVALID_TOOL_INPUT');
    // problems name fields, never values
    expect(JSON.stringify(result.error?.details ?? {})).not.toContain('document content');
  });
});
