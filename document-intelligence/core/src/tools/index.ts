/** Document Intelligence Tool System tools. Declarations are pure metadata:
 *  registration grants nothing, execution stays inside the Tool System
 *  pipeline. Handlers are read/process only - extracted text, tables and
 *  OCR output are UNTRUSTED DATA and never authorization. */
import {
  defineTool,
  ToolExecutionError,
  type ToolDefinition,
  type ToolImplementation,
} from '@veltravia/tool-core';
import { asFileAssetId } from '@veltravia/file-intelligence-core';
import { DocumentIntelligenceError } from '../errors/index.js';
import type { DocumentIntelligenceManager } from '../manager/index.js';
import type { FilePrincipal } from '@veltravia/file-intelligence-core';

const fileIdProp = {
  type: 'string',
  description: 'Opaque document file id.',
  minLength: 1,
  maxLength: 128,
} as const;

export function createDocumentIntelligenceTools(
  manager: DocumentIntelligenceManager,
  principal: FilePrincipal,
): { definitions: ToolDefinition[]; implementations: ToolImplementation[] } {
  const definitions: ToolDefinition[] = [];
  const implementations: ToolImplementation[] = [];

  const add = (
    definition: ToolDefinition,
    handler: (i: Readonly<Record<string, unknown>>) => Promise<Record<string, unknown>>,
  ) => {
    definitions.push(definition);
    implementations.push({
      toolId: definition.id,
      handler: async (input: Readonly<Record<string, unknown>>) => {
        try {
          return await handler(input);
        } catch (e) {
          if (e instanceof DocumentIntelligenceError)
            throw new ToolExecutionError(definition.id, e.message, { details: { cause: e.code } });
          throw e;
        }
      },
    });
  };

  const str = (i: Readonly<Record<string, unknown>>, k: string): string => {
    const v = i[k];
    if (typeof v !== 'string' || !v)
      throw new ToolExecutionError(definitionId, `${k} is required.`);
    return v;
  };
  const definitionId = 'document';

  const fileIdOf = (i: Readonly<Record<string, unknown>>): string => str(i, 'fileId');

  add(
    defineTool({
      id: 'document.inspect',
      name: 'Inspect Document',
      description:
        'Detect a document format from magic bytes and report its capabilities. Read-only.',
      category: 'data',
      inputSchema: {
        type: 'object',
        properties: { fileId: fileIdProp },
        required: ['fileId'],
        additionalProperties: false,
      },
      version: '0.1.0',
      requiredPermissions: ['document.read'],
      riskLevel: 'low',
      outputSchema: {
        type: 'object',
        properties: {
          fileId: fileIdProp,
          result: { type: 'string', description: 'Result reference.' },
        },
        additionalProperties: true,
      } as never,
      requiresConfirmation: false,
    }),
    async (i) => {
      const view = await manager.inspect(asFileAssetId(fileIdOf(i)), principal);
      return { ...view };
    },
  );

  add(
    defineTool({
      id: 'document.process',
      name: 'Process Document',
      description:
        'Parse a document into a bounded structural view (elements, tables, sections). Deterministic local parsing; scripts inside documents are never executed.',
      category: 'data',
      inputSchema: {
        type: 'object',
        properties: { fileId: fileIdProp },
        required: ['fileId'],
        additionalProperties: false,
      },
      version: '0.1.0',
      requiredPermissions: ['document.read'],
      riskLevel: 'low',
      outputSchema: {
        type: 'object',
        properties: {
          fileId: fileIdProp,
          result: { type: 'string', description: 'Result reference.' },
        },
        additionalProperties: true,
      } as never,
      requiresConfirmation: false,
    }),
    async (i) => {
      const job = await manager.process(asFileAssetId(fileIdOf(i)), principal);
      return { ...job };
    },
  );

  add(
    defineTool({
      id: 'document.get_job',
      name: 'Get Document Job',
      description: 'Read a document processing job status. Read-only.',
      category: 'data',
      inputSchema: {
        type: 'object',
        properties: { jobId: { type: 'string', minLength: 1, maxLength: 128 } },
        required: ['jobId'],
        additionalProperties: false,
      },
      version: '0.1.0',
      requiredPermissions: ['document.read'],
      riskLevel: 'low',
      outputSchema: {
        type: 'object',
        properties: {
          fileId: fileIdProp,
          result: { type: 'string', description: 'Result reference.' },
        },
        additionalProperties: true,
      } as never,
      requiresConfirmation: false,
    }),
    async (i) => {
      const job = await manager.getJob(str(i, 'jobId'));
      return { ...job };
    },
  );

  add(
    defineTool({
      id: 'document.structure',
      name: 'Get Document Structure',
      description:
        'Read the parsed structural view of a processed document. Content is untrusted data.',
      category: 'data',
      inputSchema: {
        type: 'object',
        properties: { fileId: fileIdProp },
        required: ['fileId'],
        additionalProperties: false,
      },
      version: '0.1.0',
      requiredPermissions: ['document.read'],
      riskLevel: 'low',
      outputSchema: {
        type: 'object',
        properties: {
          fileId: fileIdProp,
          result: { type: 'string', description: 'Result reference.' },
        },
        additionalProperties: true,
      } as never,
      requiresConfirmation: false,
    }),
    async (i) => {
      const structure = await manager.getStructure(asFileAssetId(fileIdOf(i)), principal);
      return { ...structure };
    },
  );

  add(
    defineTool({
      id: 'document.search',
      name: 'Search Document Text',
      description: 'Deterministic exact-text search over the parsed document. Read-only.',
      category: 'data',
      inputSchema: {
        type: 'object',
        properties: { fileId: fileIdProp, query: { type: 'string', minLength: 1, maxLength: 500 } },
        required: ['fileId', 'query'],
        additionalProperties: false,
      },
      version: '0.1.0',
      requiredPermissions: ['document.read'],
      riskLevel: 'low',
      outputSchema: {
        type: 'object',
        properties: {
          fileId: fileIdProp,
          result: { type: 'string', description: 'Result reference.' },
        },
        additionalProperties: true,
      } as never,
      requiresConfirmation: false,
    }),
    async (i) => {
      const result = await manager.searchExact(
        asFileAssetId(fileIdOf(i)),
        str(i, 'query'),
        principal,
      );
      return { ...result };
    },
  );

  add(
    defineTool({
      id: 'document.semantic_search',
      name: 'Semantic Document Search',
      description: 'Provider-mediated semantic search over a processed document.',
      category: 'data',
      inputSchema: {
        type: 'object',
        properties: { fileId: fileIdProp, query: { type: 'string', minLength: 1, maxLength: 500 } },
        required: ['fileId', 'query'],
        additionalProperties: false,
      },
      version: '0.1.0',
      requiredPermissions: ['document.reason'],
      riskLevel: 'low',
      outputSchema: {
        type: 'object',
        properties: {
          fileId: fileIdProp,
          result: { type: 'string', description: 'Result reference.' },
        },
        additionalProperties: true,
      } as never,
      requiresConfirmation: false,
    }),
    async (i) => {
      const result = await manager.semanticSearch(
        asFileAssetId(fileIdOf(i)),
        str(i, 'query'),
        principal,
      );
      return { ...result };
    },
  );

  add(
    defineTool({
      id: 'document.ask',
      name: 'Ask Document',
      description: 'Ask a question about a processed document; answers cite verified evidence.',
      category: 'data',
      inputSchema: {
        type: 'object',
        properties: {
          fileId: fileIdProp,
          question: { type: 'string', minLength: 1, maxLength: 2000 },
        },
        required: ['fileId', 'question'],
        additionalProperties: false,
      },
      version: '0.1.0',
      requiredPermissions: ['document.reason'],
      riskLevel: 'low',
      outputSchema: {
        type: 'object',
        properties: {
          fileId: fileIdProp,
          result: { type: 'string', description: 'Result reference.' },
        },
        additionalProperties: true,
      } as never,
      requiresConfirmation: false,
    }),
    async (i) => {
      const answer = await manager.ask(asFileAssetId(fileIdOf(i)), str(i, 'question'), principal);
      return { ...answer };
    },
  );

  add(
    defineTool({
      id: 'document.summarize',
      name: 'Summarize Document',
      description: 'Summarize a processed document (brief, bullets or executive mode).',
      category: 'data',
      inputSchema: {
        type: 'object',
        properties: {
          fileId: fileIdProp,
          mode: { type: 'string', enum: ['brief', 'bullets', 'executive'] },
        },
        required: ['fileId', 'mode'],
        additionalProperties: false,
      },
      version: '0.1.0',
      requiredPermissions: ['document.reason'],
      riskLevel: 'low',
      outputSchema: {
        type: 'object',
        properties: {
          fileId: fileIdProp,
          result: { type: 'string', description: 'Result reference.' },
        },
        additionalProperties: true,
      } as never,
      requiresConfirmation: false,
    }),
    async (i) => {
      const mode = str(i, 'mode');
      if (mode !== 'brief' && mode !== 'bullets' && mode !== 'executive')
        throw new ToolExecutionError(
          'document.summarize',
          'mode must be brief, bullets or executive.',
        );
      const summary = await manager.summarize(asFileAssetId(fileIdOf(i)), mode, principal);
      return { ...summary };
    },
  );

  add(
    defineTool({
      id: 'document.entities',
      name: 'Extract Document Entities',
      description: 'Extract named entities from a processed document.',
      category: 'data',
      inputSchema: {
        type: 'object',
        properties: { fileId: fileIdProp },
        required: ['fileId'],
        additionalProperties: false,
      },
      version: '0.1.0',
      requiredPermissions: ['document.reason'],
      riskLevel: 'low',
      outputSchema: {
        type: 'object',
        properties: {
          fileId: fileIdProp,
          result: { type: 'string', description: 'Result reference.' },
        },
        additionalProperties: true,
      } as never,
      requiresConfirmation: false,
    }),
    async (i) => {
      const entities = await manager.extractEntities(asFileAssetId(fileIdOf(i)), principal);
      return { ...entities };
    },
  );

  add(
    defineTool({
      id: 'document.compare',
      name: 'Compare Documents',
      description: 'Compare two processed documents and list key differences.',
      category: 'data',
      inputSchema: {
        type: 'object',
        properties: {
          leftFileId: fileIdProp,
          rightFileId: fileIdProp,
        },
        required: ['leftFileId', 'rightFileId'],
        additionalProperties: false,
      },
      version: '0.1.0',
      requiredPermissions: ['document.reason'],
      riskLevel: 'low',
      outputSchema: {
        type: 'object',
        properties: {
          fileId: fileIdProp,
          result: { type: 'string', description: 'Result reference.' },
        },
        additionalProperties: true,
      } as never,
      requiresConfirmation: false,
    }),
    async (i) => {
      const comparison = await manager.compare(
        asFileAssetId(str(i, 'leftFileId')),
        asFileAssetId(str(i, 'rightFileId')),
        principal,
      );
      return { ...comparison };
    },
  );

  add(
    defineTool({
      id: 'document.ocr',
      name: 'Read Document Text (OCR)',
      description: 'Extract readable text from a processed document. Untrusted data.',
      category: 'data',
      inputSchema: {
        type: 'object',
        properties: { fileId: fileIdProp },
        required: ['fileId'],
        additionalProperties: false,
      },
      version: '0.1.0',
      requiredPermissions: ['document.reason'],
      riskLevel: 'low',
      outputSchema: {
        type: 'object',
        properties: {
          fileId: fileIdProp,
          result: { type: 'string', description: 'Result reference.' },
        },
        additionalProperties: true,
      } as never,
      requiresConfirmation: false,
    }),
    async (i) => {
      const result = await manager.ocr(asFileAssetId(fileIdOf(i)), principal);
      return { ...result };
    },
  );

  add(
    defineTool({
      id: 'document.spreadsheet_view',
      name: 'View Spreadsheet Structure',
      description: 'Sheet names, headers, row counts and numeric statistics for spreadsheets.',
      category: 'data',
      inputSchema: {
        type: 'object',
        properties: { fileId: fileIdProp },
        required: ['fileId'],
        additionalProperties: false,
      },
      version: '0.1.0',
      requiredPermissions: ['document.read'],
      riskLevel: 'low',
      outputSchema: {
        type: 'object',
        properties: {
          fileId: fileIdProp,
          result: { type: 'string', description: 'Result reference.' },
        },
        additionalProperties: true,
      } as never,
      requiresConfirmation: false,
    }),
    async (i) => {
      const view = await manager.spreadsheetView(asFileAssetId(fileIdOf(i)), principal);
      return { ...view };
    },
  );

  add(
    defineTool({
      id: 'document.presentation_view',
      name: 'View Presentation Structure',
      description: 'Slide titles, bullets and notes for presentations.',
      category: 'data',
      inputSchema: {
        type: 'object',
        properties: { fileId: fileIdProp },
        required: ['fileId'],
        additionalProperties: false,
      },
      version: '0.1.0',
      requiredPermissions: ['document.read'],
      riskLevel: 'low',
      outputSchema: {
        type: 'object',
        properties: {
          fileId: fileIdProp,
          result: { type: 'string', description: 'Result reference.' },
        },
        additionalProperties: true,
      } as never,
      requiresConfirmation: false,
    }),
    async (i) => {
      const view = await manager.presentationView(asFileAssetId(fileIdOf(i)), principal);
      return { ...view };
    },
  );

  add(
    defineTool({
      id: 'document.memory_candidates',
      name: 'Document Memory Candidates',
      description:
        'Non-authoritative memory candidates derived from a processed document structure.',
      category: 'data',
      inputSchema: {
        type: 'object',
        properties: { fileId: fileIdProp },
        required: ['fileId'],
        additionalProperties: false,
      },
      version: '0.1.0',
      requiredPermissions: ['document.read'],
      riskLevel: 'low',
      outputSchema: {
        type: 'object',
        properties: {
          fileId: fileIdProp,
          result: { type: 'string', description: 'Result reference.' },
        },
        additionalProperties: true,
      } as never,
      requiresConfirmation: false,
    }),
    async (i) => {
      const candidates = await manager.memoryCandidates(asFileAssetId(fileIdOf(i)), principal);
      return { candidates: [...candidates] };
    },
  );

  return { definitions, implementations };
}
