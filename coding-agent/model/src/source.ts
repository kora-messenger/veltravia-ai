/**
 * The model-powered `CodingDecisionSource`.
 *
 * It plugs into the EXISTING coding agent: the same state machine, the same
 * validated plan gate, the same Tool System, the same revision protection and
 * the same sandbox. The only thing that changes is where the next decision
 * comes from - a real configured model instead of a script.
 *
 * Honesty rules enforced here:
 *   - a plan produced by this source is marked `origin: 'model'`;
 *   - if the reply cannot be parsed, it is re-asked ONCE with the parse error
 *     and then the run fails with a typed error - the scripted source is never
 *     substituted;
 *   - if the port reports that no real provider answered, the run fails with
 *     `CODING_MODEL_UNAVAILABLE` instead of pretending.
 */

import { validateCodingDecision, type CodingDecision } from '@veltravia/coding-agent-core';
import type { CodingDecisionContext, CodingDecisionSource } from '@veltravia/coding-agent-core';

import type { CodingModelClient, CodingModelReply, CodingModelRequest } from './client.js';
import { ModelCodingError, scrubModelText } from './errors.js';
import { normaliseDecisionShape, parseModelDecision } from './parse.js';
import { buildDecisionPrompt, DEFAULT_PROMPT_LIMITS, type PromptLimits } from './prompt.js';

export interface ModelCodingOptions {
  readonly client: CodingModelClient;
  readonly limits?: Partial<PromptLimits>;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  /** How many times an unparseable reply may be re-asked (0 = never). Default 1. */
  readonly maxRepairAttempts?: number;
  /** Called after every exchange, for progress reporting. */
  readonly onExchange?: (exchange: ModelExchange) => void;
  /** Aborts the in-flight model call when the run is cancelled. */
  readonly signalFor?: (runId: string) => AbortSignal | undefined;
}

export interface ModelExchange {
  readonly runId: string;
  readonly attempt: number;
  readonly providerId: string;
  readonly modelId: string;
  readonly providerName: string;
  readonly live: boolean;
  readonly decisionType: string | null;
  readonly evidenceChars: number;
  readonly filesIncluded: number;
  readonly truncated: boolean;
  readonly usage: {
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
  } | null;
}

export interface ModelCodingSource extends CodingDecisionSource {
  /** Every exchange so far, in order. Read by the API for an honest run view. */
  exchanges(): readonly ModelExchange[];
}

export function createModelCodingDecisionSource(options: ModelCodingOptions): ModelCodingSource {
  const { client, maxOutputTokens = 4000, temperature = 0.2, maxRepairAttempts = 1 } = options;
  const limits: PromptLimits = { ...DEFAULT_PROMPT_LIMITS, ...options.limits };
  const history: ModelExchange[] = [];

  return {
    exchanges: () => [...history],

    async nextDecision(context: CodingDecisionContext): Promise<CodingDecision> {
      const prompt = buildDecisionPrompt(context, limits);
      let messages = [...prompt.messages];
      let lastError: ModelCodingError | null = null;

      for (let attempt = 0; attempt <= maxRepairAttempts; attempt += 1) {
        let reply;
        try {
          reply = await requestCompletion(client, {
            messages,
            maxOutputTokens,
            temperature,
            signal: options.signalFor?.(context.runId),
          });
        } catch (error) {
          if (error instanceof ModelCodingError) throw error;
          const message = scrubModelText((error as Error).message ?? 'model call failed');
          throw new ModelCodingError(
            /abort|cancel/i.test(message)
              ? 'CODING_MODEL_CANCELLED'
              : 'CODING_MODEL_PROVIDER_ERROR',
            message,
          );
        }
        if (!reply.live) {
          throw new ModelCodingError(
            'CODING_MODEL_UNAVAILABLE',
            'the response did not come from a real provider, so it is not treated as model output',
          );
        }

        let raw: unknown;
        try {
          raw = normaliseDecisionShape(parseModelDecision(reply.text)).value;
        } catch (error) {
          lastError =
            error instanceof ModelCodingError
              ? error
              : new ModelCodingError('CODING_MODEL_INVALID_OUTPUT', String(error));
          history.push({
            runId: context.runId,
            attempt,
            providerId: reply.providerId,
            modelId: reply.modelId,
            providerName: client.providerName,
            live: reply.live,
            decisionType: null,
            evidenceChars: prompt.evidenceChars,
            filesIncluded: prompt.filesIncluded,
            truncated: prompt.truncated,
            usage: reply.usage ?? null,
          });
          if (attempt < maxRepairAttempts) {
            messages = [
              ...prompt.messages,
              { role: 'assistant', content: reply.text.slice(0, 4000) },
              {
                role: 'user',
                content: `That reply was rejected: ${lastError.message}. Reply with ONE valid JSON decision object only, no prose and no code fences.`,
              },
            ];
            continue;
          }
          throw lastError;
        }

        // Plan provenance: a model plan says so, structurally.
        const candidate =
          raw !== null && typeof raw === 'object' && (raw as { type?: unknown }).type === 'plan'
            ? {
                ...(raw as { plan: Record<string, unknown> }),
                plan: {
                  ...((raw as { plan: Record<string, unknown> }).plan ?? {}),
                  origin: 'model',
                },
              }
            : raw;

        let decision: CodingDecision;
        try {
          decision = validateCodingDecision(candidate);
        } catch (error) {
          const message = scrubModelText((error as Error).message ?? 'invalid decision');
          history.push({
            runId: context.runId,
            attempt,
            providerId: reply.providerId,
            modelId: reply.modelId,
            providerName: client.providerName,
            live: reply.live,
            decisionType: 'invalid',
            evidenceChars: prompt.evidenceChars,
            filesIncluded: prompt.filesIncluded,
            truncated: prompt.truncated,
            usage: reply.usage ?? null,
          });
          throw new ModelCodingError(
            'CODING_MODEL_INVALID_OUTPUT',
            `rejected model decision: ${message}`,
          );
        }

        history.push({
          runId: context.runId,
          attempt,
          providerId: reply.providerId,
          modelId: reply.modelId,
          providerName: client.providerName,
          live: reply.live,
          decisionType: decision.type,
          evidenceChars: prompt.evidenceChars,
          filesIncluded: prompt.filesIncluded,
          truncated: prompt.truncated,
          usage: reply.usage ?? null,
        });
        return decision;
      }

      throw (
        lastError ?? new ModelCodingError('CODING_MODEL_INVALID_OUTPUT', 'no decision produced')
      );
    },
  };
}

/**
 * Asks for a completion, lowering the requested ceiling when the provider says
 * it cannot RESERVE that many output tokens on the account's balance.
 *
 * A 402 that names max_tokens is not a dead key: a real run against a
 * low-balance OpenRouter account failed with "cannot reserve that many output
 * tokens" while the same key answered a smaller request, so the ceiling is
 * adaptively lowered instead of losing the run.
 */
async function requestCompletion(
  client: CodingModelClient,
  request: CodingModelRequest,
): Promise<CodingModelReply> {
  let ceiling = request.maxOutputTokens;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await client.complete({ ...request, maxOutputTokens: ceiling });
    } catch (error) {
      const message = String((error as Error)?.message ?? '');
      const unaffordable = /output tokens|max_tokens|reserve/i.test(message);
      if (!unaffordable || attempt >= 3 || ceiling <= 256) throw error;
      // When the provider says exactly what the balance can afford, ask for
      // that instead of guessing: the same key served 512 tokens happily.
      const affordable = Number(/can only afford (\d+)/i.exec(message)?.[1] ?? '0');
      ceiling =
        Number.isFinite(affordable) && affordable > 0
          ? Math.max(256, Math.min(ceiling - 1, Math.floor(affordable * 0.9)))
          : Math.max(256, Math.floor(ceiling / 2));
    }
  }
}
