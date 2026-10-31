/** Intelligence Tool System tools (Step 25).
 *
 * Read-only. Registration grants nothing: the API wiring grants the safe read
 * tools explicitly, and every call still resolves sources through the owner's
 * own adapters. Retrieved content stays UNTRUSTED DATA - a tool result can never
 * be a permission grant or an instruction.
 */
import {
  defineTool,
  ToolExecutionError,
  type ToolDefinition,
  type ToolImplementation,
} from '@veltravia/tool-core';
import { IntelligenceError, isIntelligenceError } from '../errors/index.js';
import type { CrossSourceSearch } from '../search/index.js';
import type { EvidenceCollector } from '../evidence/index.js';
import type { IntelligenceEngine } from '../synthesis/index.js';
import { isSourceProvider, isSourceType, type SourceProvider } from '../types/index.js';

export interface IntelligenceToolDeps {
  readonly engine: IntelligenceEngine;
  readonly search: CrossSourceSearch;
  readonly collectorFor: (ownerRef: string) => EvidenceCollector | null;
  readonly ownerRef: string;
}

function pruneNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => pruneNulls(entry));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === null || entry === undefined) continue;
      out[key] = pruneNulls(entry);
    }
    return out;
  }
  return value;
}

const providerProp = {
  type: 'string',
  description: 'Source provider: files, github, google_drive, notion or workspace.',
  enum: ['files', 'github', 'google_drive', 'notion', 'workspace'],
} as const;

const questionProp = {
  type: 'string',
  description: 'The question to investigate across authorized sources.',
  minLength: 1,
  maxLength: 500,
} as const;

export function createIntelligenceTools(deps: IntelligenceToolDeps): {
  definitions: ToolDefinition[];
  implementations: ToolImplementation[];
} {
  const definitions: ToolDefinition[] = [];
  const implementations: ToolImplementation[] = [];
  const owner = { ownerRef: deps.ownerRef };

  const add = (
    definition: ToolDefinition,
    handler: (input: Readonly<Record<string, unknown>>) => Promise<Record<string, unknown>>,
  ) => {
    definitions.push(definition);
    implementations.push({
      toolId: definition.id,
      handler: async (input) => {
        try {
          return pruneNulls(await handler(input)) as Record<string, unknown>;
        } catch (error) {
          if (isIntelligenceError(error))
            throw new ToolExecutionError(definition.id, error.message, {
              details: { cause: error.code },
            });
          if (error instanceof IntelligenceError)
            throw new ToolExecutionError(definition.id, error.message);
          throw new ToolExecutionError(definition.id, 'The intelligence operation failed.');
        }
      },
    });
  };

  add(
    defineTool({
      id: 'intelligence.discover_sources',
      name: 'Discover Sources',
      description:
        'List the sources this user may search: uploaded documents, connected-app resources and project files. Read-only.',
      category: 'data',
      inputSchema: {
        type: 'object',
        properties: {
          provider: { ...providerProp, description: 'Optional provider filter.' },
          project_id: { type: 'string', description: 'Optional project filter.', maxLength: 120 },
          limit: { type: 'number', description: 'Maximum sources to return (max 100).' },
        },
        additionalProperties: false,
      },
      version: '0.1.0',
      requiredPermissions: ['intelligence.read'],
      riskLevel: 'low',
      requiresConfirmation: false,
      outputSchema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          sources: {
            type: 'array',
            description: 'Authorized sources.',
            items: {
              type: 'object',
              properties: {
                sourceId: { type: 'string', description: 'Source id.' },
                provider: { type: 'string', description: 'Provider.' },
                name: { type: 'string', description: 'Display name.' },
                sourceType: { type: 'string', description: 'Source type.' },
                modifiedAt: { type: 'string', description: 'Last modification.' },
                contentVersion: { type: 'string', description: 'Content version.' },
                projectId: { type: 'string', description: 'Owning project.' },
              },
              additionalProperties: true,
            },
          },
          unavailableProviders: {
            type: 'array',
            description: 'Providers that were not searched, with the reason.',
            items: {
              type: 'object',
              properties: {
                provider: { type: 'string', description: 'Provider id.' },
                detail: { type: 'string', description: 'Why it was unavailable.' },
              },
              additionalProperties: true,
            },
          },
        },
      },
    }),
    async (input) => {
      const provider = typeof input.provider === 'string' ? input.provider : null;
      if (provider !== null && !isSourceProvider(provider))
        throw new IntelligenceError('INTELLIGENCE_INVALID_REQUEST', 'Unknown provider.');
      const sources = await deps.engine.registry.discover(owner, {
        providers: provider ? [provider] : undefined,
        projectId: typeof input.project_id === 'string' ? input.project_id : null,
        limit: Math.min(Number(input.limit ?? 50) || 50, 100),
      });
      const availability = await deps.engine.registry.availability(owner);
      return {
        sources: sources.map((source) => ({
          sourceId: source.sourceId,
          provider: source.provider,
          name: source.name,
          sourceType: source.sourceType,
          modifiedAt: source.modifiedAt,
          contentVersion: source.contentVersion,
          projectId: source.projectId,
        })),
        unavailableProviders: availability
          .filter((entry) => !entry.available)
          .map((entry) => ({ provider: entry.provider, detail: entry.detail })),
      };
    },
  );

  add(
    defineTool({
      id: 'intelligence.search',
      name: 'Search All Sources',
      description:
        'Search across every authorized source with ranking, deduplication and provenance. Read-only.',
      category: 'data',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search text.', minLength: 1, maxLength: 200 },
          provider: { ...providerProp, description: 'Optional provider filter.' },
          source_type: {
            type: 'string',
            description: 'Optional source type filter.',
            enum: ['uploaded_document', 'connected_resource', 'project_file'],
          },
          limit: { type: 'number', description: 'Maximum hits (max 25).' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      version: '0.1.0',
      requiredPermissions: ['intelligence.read'],
      riskLevel: 'low',
      requiresConfirmation: false,
      outputSchema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          hits: {
            type: 'array',
            description: 'Ranked hits with provenance.',
            items: {
              type: 'object',
              properties: {
                sourceId: { type: 'string', description: 'Source id.' },
                provider: { type: 'string', description: 'Provider.' },
                name: { type: 'string', description: 'Source name.' },
                score: { type: 'number', description: 'Rank score.' },
                locator: { type: 'string', description: 'Passage location.' },
                snippet: { type: 'string', description: 'Matching passage.' },
                reasons: {
                  type: 'array',
                  description: 'Ranking reasons.',
                  items: { type: 'string' },
                },
                revision: { type: 'string', description: 'Content version.' },
                retrievedAt: { type: 'string', description: 'Retrieval time.' },
              },
              additionalProperties: true,
            },
          },
          totalMatched: { type: 'number', description: 'Total matches before paging.' },
          duplicatesRemoved: { type: 'number', description: 'Identical sources collapsed.' },
          unavailableProviders: {
            type: 'array',
            description: 'Providers not searched.',
            items: { type: 'string' },
          },
        },
      },
    }),
    async (input) => {
      const provider = typeof input.provider === 'string' ? input.provider : null;
      const sourceType = typeof input.source_type === 'string' ? input.source_type : null;
      if (provider !== null && !isSourceProvider(provider))
        throw new IntelligenceError('INTELLIGENCE_INVALID_REQUEST', 'Unknown provider.');
      if (sourceType !== null && !isSourceType(sourceType))
        throw new IntelligenceError('INTELLIGENCE_INVALID_REQUEST', 'Unknown source type.');
      const response = await deps.search.search(owner, {
        text: String(input.query ?? ''),
        providers: provider ? [provider as SourceProvider] : undefined,
        sourceTypes: sourceType ? [sourceType] : undefined,
        limit: Math.min(Number(input.limit ?? 10) || 10, 25),
      });
      return {
        totalMatched: response.totalMatched,
        duplicatesRemoved: response.duplicatesRemoved,
        hits: response.hits.map((hit) => ({
          sourceId: hit.source.sourceId,
          provider: hit.source.provider,
          name: hit.source.name,
          score: hit.score,
          locator: hit.locator.label,
          snippet: hit.snippet,
          reasons: [...hit.reasons],
          revision: hit.source.contentVersion,
          retrievedAt: hit.source.retrievedAt,
        })),
        unavailableProviders: response.unavailableProviders.map((entry) => entry.provider),
      };
    },
  );

  add(
    defineTool({
      id: 'intelligence.evidence',
      name: 'Retrieve Evidence',
      description:
        'Return the evidence collected for one source in the current analysis, with locators and revisions.',
      category: 'data',
      inputSchema: {
        type: 'object',
        properties: {
          source_id: {
            type: 'string',
            description: 'Source id from a search hit.',
            maxLength: 320,
          },
        },
        required: ['source_id'],
        additionalProperties: false,
      },
      version: '0.1.0',
      requiredPermissions: ['intelligence.read'],
      riskLevel: 'low',
      requiresConfirmation: false,
      outputSchema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          evidence: {
            type: 'array',
            description: 'Cited passages.',
            items: {
              type: 'object',
              properties: {
                evidenceId: { type: 'string', description: 'Evidence id.' },
                locator: { type: 'string', description: 'Passage location.' },
                excerpt: { type: 'string', description: 'Quoted passage.' },
                revision: { type: 'string', description: 'Content version.' },
                retrievedAt: { type: 'string', description: 'Retrieval time.' },
                verified: { type: 'boolean', description: 'Whether the quote was re-checked.' },
              },
              additionalProperties: true,
            },
          },
        },
      },
    }),
    async (input) => {
      const collector = deps.collectorFor(deps.ownerRef);
      const sourceId = String(input.source_id ?? '');
      const fromCollector = collector
        ? collector.all().filter((item) => item.sourceId === sourceId)
        : [];
      if (fromCollector.length > 0)
        return {
          evidence: fromCollector.map((item) => ({
            evidenceId: item.evidenceId,
            locator: item.locator.label,
            excerpt: item.excerpt,
            revision: item.revision,
            retrievedAt: item.retrievedAt,
            verified: item.verified,
          })),
        };
      // No analysis has run for this owner yet: read and cite the first segments
      // so the answer can still point at real text.
      const content = await deps.engine.registry.read(owner, sourceId);
      return {
        evidence: content.segments.slice(0, 3).map((segment) => ({
          evidenceId: `ev:${sourceId}:${segment.segmentId}`,
          locator: segment.locator.label,
          excerpt: segment.text.slice(0, 240),
          revision: content.source.contentVersion,
          retrievedAt: content.source.retrievedAt,
          verified: true,
        })),
      };
    },
  );

  add(
    defineTool({
      id: 'intelligence.synthesize',
      name: 'Synthesize Answer',
      description:
        'Investigate a question across authorized sources and return a structured answer with evidence, contradictions and gaps. Read-only.',
      category: 'data',
      inputSchema: {
        type: 'object',
        properties: {
          question: questionProp,
          provider: { ...providerProp, description: 'Optional provider filter.' },
          project_id: { type: 'string', description: 'Optional project filter.', maxLength: 120 },
        },
        required: ['question'],
        additionalProperties: false,
      },
      version: '0.1.0',
      requiredPermissions: ['intelligence.read'],
      riskLevel: 'low',
      requiresConfirmation: false,
      outputSchema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          status: { type: 'string', description: 'answered, partial or no_evidence.' },
          summary: { type: 'string', description: 'Evidence-backed summary.' },
          claims: {
            type: 'array',
            description: 'Claims with evidence ids.',
            items: {
              type: 'object',
              properties: {
                statement: { type: 'string', description: 'Claim text.' },
                kind: { type: 'string', description: 'Claim kind.' },
                confidence: { type: 'number', description: 'Confidence 0..1.' },
                evidenceIds: {
                  type: 'array',
                  description: 'Cited evidence.',
                  items: { type: 'string' },
                },
              },
              additionalProperties: true,
            },
          },
          evidence: {
            type: 'array',
            description: 'Cited passages.',
            items: {
              type: 'object',
              properties: {
                evidenceId: { type: 'string', description: 'Evidence id.' },
                sourceId: { type: 'string', description: 'Source id.' },
                resourceName: { type: 'string', description: 'Source name.' },
                locator: { type: 'string', description: 'Passage location.' },
                excerpt: { type: 'string', description: 'Quoted passage.' },
              },
              additionalProperties: true,
            },
          },
          reasoning: {
            type: 'object',
            description: 'Which reasoning mode produced this.',
            properties: {
              provider: { type: 'string', description: 'Provider id.' },
              mode: { type: 'string', description: 'Reasoning mode.' },
              simulated: { type: 'boolean', description: 'True when not a real model.' },
              detail: { type: 'string', description: 'Honest description.' },
            },
            additionalProperties: true,
          },
          gaps: { type: 'array', description: 'Missing information.', items: { type: 'string' } },
        },
      },
    }),
    async (input) => {
      const provider = typeof input.provider === 'string' ? input.provider : null;
      if (provider !== null && !isSourceProvider(provider))
        throw new IntelligenceError('INTELLIGENCE_INVALID_REQUEST', 'Unknown provider.');
      const answer = await deps.engine.synthesize(owner, String(input.question ?? ''), {
        providers: provider ? [provider as SourceProvider] : undefined,
        projectId: typeof input.project_id === 'string' ? input.project_id : null,
        limit: 8,
      });
      return {
        status: answer.status,
        intent: answer.intent,
        summary: answer.summary,
        reasoning: answer.reasoning,
        claims: answer.claims.map((claim) => ({
          statement: claim.statement,
          kind: claim.kind,
          confidence: claim.confidence,
          evidenceIds: [...claim.evidenceIds],
        })),
        evidence: answer.evidence.map((item) => ({
          evidenceId: item.evidenceId,
          sourceId: item.sourceId,
          resourceName: item.resourceName,
          locator: item.locator.label,
          excerpt: item.excerpt,
        })),
        contradictions: answer.contradictions.map((item) => ({
          topic: item.topic,
          kind: item.kind,
          resolvable: item.resolvable,
          explanation: item.explanation,
        })),
        gaps: answer.gaps.map((gap) => gap.description),
      };
    },
  );

  add(
    defineTool({
      id: 'intelligence.contradictions',
      name: 'Detect Contradictions',
      description:
        'Compare authorized sources and report conflicting statements without choosing a winner.',
      category: 'data',
      inputSchema: {
        type: 'object',
        properties: { question: questionProp },
        required: ['question'],
        additionalProperties: false,
      },
      version: '0.1.0',
      requiredPermissions: ['intelligence.read'],
      riskLevel: 'low',
      requiresConfirmation: false,
      outputSchema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          contradictions: {
            type: 'array',
            description: 'Detected conflicts.',
            items: {
              type: 'object',
              properties: {
                topic: { type: 'string', description: 'Conflict topic.' },
                kind: { type: 'string', description: 'Conflict kind.' },
                explanation: { type: 'string', description: 'Why it conflicts.' },
                confidence: { type: 'number', description: 'Confidence 0..1.' },
                resolvable: { type: 'boolean', description: 'Whether evidence settles it.' },
                resolution: { type: 'string', description: 'How it could be resolved.' },
                statements: {
                  type: 'array',
                  description: 'Each conflicting statement.',
                  items: {
                    type: 'object',
                    properties: {
                      text: { type: 'string', description: 'Statement text.' },
                      sourceId: { type: 'string', description: 'Source id.' },
                      revision: { type: 'string', description: 'Content version.' },
                    },
                    additionalProperties: true,
                  },
                },
              },
              additionalProperties: true,
            },
          },
        },
      },
    }),
    async (input) => {
      const answer = await deps.engine.synthesize(owner, String(input.question ?? ''), {
        limit: 8,
      });
      return {
        contradictions: answer.contradictions.map((item) => ({
          topic: item.topic,
          kind: item.kind,
          explanation: item.explanation,
          confidence: item.confidence,
          resolvable: item.resolvable,
          resolution: item.resolution,
          statements: item.statements.map((statement) => ({
            text: statement.text,
            sourceId: statement.sourceId,
            revision: statement.revision,
          })),
        })),
      };
    },
  );

  add(
    defineTool({
      id: 'intelligence.relationships',
      name: 'Source Relationships',
      description: 'List the relationships discovered between authorized sources.',
      category: 'data',
      inputSchema: {
        type: 'object',
        properties: { question: questionProp },
        required: ['question'],
        additionalProperties: false,
      },
      version: '0.1.0',
      requiredPermissions: ['intelligence.read'],
      riskLevel: 'low',
      requiresConfirmation: false,
      outputSchema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          relationships: {
            type: 'array',
            description: 'Inferred relationships.',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', description: 'Relationship kind.' },
                from: { type: 'string', description: 'From source.' },
                to: { type: 'string', description: 'To source.' },
                explanation: { type: 'string', description: 'Why it exists.' },
                confidence: { type: 'number', description: 'Confidence 0..1.' },
                inferred: { type: 'boolean', description: 'Always true.' },
              },
              additionalProperties: true,
            },
          },
        },
      },
    }),
    async (input) => {
      const answer = await deps.engine.synthesize(owner, String(input.question ?? ''), {
        limit: 8,
      });
      return {
        relationships: answer.relationships.map((item) => ({
          kind: item.kind,
          from: item.fromSourceId,
          to: item.toSourceId,
          explanation: item.explanation,
          confidence: item.confidence,
          inferred: item.inferred,
        })),
      };
    },
  );

  add(
    defineTool({
      id: 'intelligence.compare',
      name: 'Compare Sources',
      description:
        'Compare two to five authorized sources: agreements, conflicts and unique sections.',
      category: 'data',
      inputSchema: {
        type: 'object',
        properties: {
          source_ids: {
            type: 'array',
            description: 'Two to five source ids.',
            items: { type: 'string', maxLength: 320 },
          },
        },
        required: ['source_ids'],
        additionalProperties: false,
      },
      version: '0.1.0',
      requiredPermissions: ['intelligence.read'],
      riskLevel: 'low',
      requiresConfirmation: false,
      outputSchema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          participants: {
            type: 'array',
            description: 'Compared sources.',
            items: {
              type: 'object',
              properties: {
                sourceId: { type: 'string', description: 'Source id.' },
                name: { type: 'string', description: 'Source name.' },
                outline: { type: 'array', description: 'Headings.', items: { type: 'string' } },
                wordCount: { type: 'number', description: 'Word count.' },
              },
              additionalProperties: true,
            },
          },
          agreements: {
            type: 'array',
            description: 'Shared, evidenced statements.',
            items: {
              type: 'object',
              properties: {
                statement: { type: 'string', description: 'Agreement text.' },
                evidenceIds: {
                  type: 'array',
                  description: 'Cited evidence.',
                  items: { type: 'string' },
                },
              },
              additionalProperties: true,
            },
          },
          contradictions: {
            type: 'array',
            description: 'Conflicts.',
            items: {
              type: 'object',
              properties: {
                topic: { type: 'string', description: 'Conflict topic.' },
                explanation: { type: 'string', description: 'Why it conflicts.' },
              },
              additionalProperties: true,
            },
          },
          onlyIn: {
            type: 'array',
            description: 'Headings unique to one source.',
            items: {
              type: 'object',
              properties: {
                sourceId: { type: 'string', description: 'Source id.' },
                headings: { type: 'array', description: 'Headings.', items: { type: 'string' } },
              },
              additionalProperties: true,
            },
          },
        },
      },
    }),
    async (input) => {
      const ids = Array.isArray(input.source_ids)
        ? input.source_ids.filter((value): value is string => typeof value === 'string')
        : [];
      const comparison = await deps.engine.compare(owner, ids);
      return {
        participants: comparison.participants.map((participant) => ({
          sourceId: participant.source.sourceId,
          name: participant.source.name,
          outline: [...participant.outline],
          wordCount: participant.wordCount,
        })),
        agreements: comparison.agreements.map((claim) => ({
          statement: claim.statement,
          evidenceIds: [...claim.evidenceIds],
        })),
        contradictions: comparison.contradictions.map((item) => ({
          topic: item.topic,
          explanation: item.explanation,
        })),
        onlyIn: comparison.onlyIn.map((entry) => ({
          sourceId: entry.sourceId,
          headings: [...entry.headings],
        })),
      };
    },
  );

  add(
    defineTool({
      id: 'intelligence.report',
      name: 'Cross-Source Report',
      description:
        'Produce a structured project report from authorized sources, citing evidence for each point.',
      category: 'data',
      inputSchema: {
        type: 'object',
        properties: {
          topic: questionProp,
          project_id: { type: 'string', description: 'Optional project filter.', maxLength: 120 },
        },
        required: ['topic'],
        additionalProperties: false,
      },
      version: '0.1.0',
      requiredPermissions: ['intelligence.read'],
      riskLevel: 'low',
      requiresConfirmation: false,
      outputSchema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          summary: { type: 'string', description: 'Report summary.' },
          sections: {
            type: 'array',
            description: 'Report sections with citations.',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', description: 'Section kind.' },
                statement: { type: 'string', description: 'Section text.' },
                citations: {
                  type: 'array',
                  description: 'Evidence ids.',
                  items: { type: 'string' },
                },
              },
              additionalProperties: true,
            },
          },
          sources: {
            type: 'array',
            description: 'Sources used.',
            items: {
              type: 'object',
              properties: {
                sourceId: { type: 'string', description: 'Source id.' },
                name: { type: 'string', description: 'Source name.' },
                provider: { type: 'string', description: 'Provider.' },
                revision: { type: 'string', description: 'Content version.' },
                retrievedAt: { type: 'string', description: 'Retrieval time.' },
              },
              additionalProperties: true,
            },
          },
        },
      },
    }),
    async (input) => {
      const answer = await deps.engine.synthesize(owner, String(input.topic ?? ''), {
        projectId: typeof input.project_id === 'string' ? input.project_id : null,
        limit: 10,
      });
      return {
        status: answer.status,
        summary: answer.summary,
        sections: answer.claims.map((claim) => ({
          kind: claim.kind,
          statement: claim.statement,
          citations: claim.evidenceIds,
        })),
        sources: answer.sources.map((source) => ({
          sourceId: source.sourceId,
          name: source.name,
          provider: source.provider,
          revision: source.contentVersion,
          retrievedAt: source.retrievedAt,
        })),
        reasoning: answer.reasoning,
      };
    },
  );

  return { definitions, implementations };
}
