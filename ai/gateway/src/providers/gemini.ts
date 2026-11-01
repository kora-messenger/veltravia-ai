import type { AIFinishReason } from '@veltravia/ai-core';

import { GatewayError } from '../errors/index.js';
import { retryHintMs } from './retry-hint.js';
import type { GatewayModel, ProviderDefinition } from '../types/index.js';
import { joinEndpoint } from '../ssrf/index.js';
import { parseJsonFrame, readSseEvents } from './sse.js';
import type {
  AdapterChunk,
  AdapterContext,
  AdapterRequest,
  AdapterResult,
  CredentialValidationResult,
  ProviderAdapter,
} from './adapter.js';

/**
 * Native Google Gemini adapter over the stable REST surface
 * (`models/{model}:generateContent`).
 *
 * The key is sent in `x-goog-api-key` rather than a query string so it cannot
 * end up in a URL, a proxy log or a browser history. The existing Step 3
 * adapter (ai/providers/gemini) uses Google's Interactions API through the
 * official SDK; this gateway adapter deliberately speaks the documented REST
 * API instead, so an owner's own key does not require the server to own an SDK
 * client per request. Both normalize to the same AI Core shapes.
 */

/**
 * A provider refusal must say WHY. "The provider rejected the request." is a
 * dead end for the person holding the key: during live QA the same message was
 * returned for a retired model, an unsupported parameter and a malformed body.
 * The provider's own message is included, scrubbed and truncated.
 */
function providerReason(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return undefined;
  const message = (error as { message?: unknown }).message;
  if (typeof message !== 'string') return undefined;
  const trimmed = message.replace(/\s+/g, ' ').trim();
  return trimmed.length === 0 ? undefined : trimmed.slice(0, 240);
}

function retryDetails(body: unknown): Record<string, number> {
  const hint = retryHintMs(body);
  return hint === undefined ? {} : { retryAfterMs: hint };
}

function statusError(status: number, body?: unknown): GatewayError {
  const reason = providerReason(body);
  const withReason = (text: string): string =>
    reason === undefined ? text : `${text} (${reason})`;
  if (status === 400)
    return new GatewayError(
      'GATEWAY_INVALID_REQUEST',
      withReason('The provider rejected the request.'),
      {
        details: { status, ...(reason !== undefined ? { providerMessage: reason } : {}) },
      },
    );
  if (status === 401 || status === 403)
    return new GatewayError('GATEWAY_AUTH_FAILED', 'The provider rejected the API key.', {
      details: { status },
    });
  if (status === 404)
    return new GatewayError(
      'GATEWAY_MODEL_UNKNOWN',
      withReason('The provider does not know that model.'),
      {
        details: { status, ...(reason !== undefined ? { providerMessage: reason } : {}) },
      },
    );
  if (status === 429)
    return new GatewayError(
      'GATEWAY_RATE_LIMITED',
      withReason('The provider is rate limiting this key.'),
      {
        details: {
          ...retryDetails(body),
          status,
          ...(reason !== undefined ? { providerMessage: reason } : {}),
        },
      },
    );
  if (status >= 500)
    return new GatewayError('GATEWAY_PROVIDER_UNAVAILABLE', 'The provider is unavailable.', {
      details: { status },
    });
  return new GatewayError(
    'GATEWAY_PROVIDER_ERROR',
    withReason('The provider rejected the request.'),
    {
      details: { status, ...(reason !== undefined ? { providerMessage: reason } : {}) },
    },
  );
}

function finishReasonOf(raw: unknown): AIFinishReason {
  if (raw === 'STOP') return 'stop';
  if (raw === 'MAX_TOKENS') return 'length';
  if (typeof raw === 'string' && raw.startsWith('SAFETY')) return 'content-filter';
  return 'unknown';
}

export class GeminiGatewayAdapter implements ProviderAdapter {
  readonly definition: ProviderDefinition;
  readonly supportsDiscovery: boolean;

  constructor(definition: ProviderDefinition) {
    this.definition = definition;
    this.supportsDiscovery = Boolean(definition.modelsPath);
  }

  private headers(context: AdapterContext): Record<string, string> {
    return { 'content-type': 'application/json', 'x-goog-api-key': context.apiKey };
  }

  private url(context: AdapterContext, path: string, query?: Record<string, string>): string {
    const endpoint = joinEndpoint(new URL(context.baseUrl), path);
    if (query) {
      for (const [key, value] of Object.entries(query)) endpoint.searchParams.set(key, value);
    }
    return endpoint.toString();
  }

  async validateCredential(context: AdapterContext): Promise<CredentialValidationResult> {
    try {
      const models = await this.discoverModels(context);
      return { valid: true, models };
    } catch (error) {
      return {
        valid: false,
        errorCategory: error instanceof GatewayError ? error.code : 'GATEWAY_PROVIDER_ERROR',
      };
    }
  }

  async discoverModels(context: AdapterContext): Promise<readonly GatewayModel[]> {
    const response = await context.transport.request({
      url: this.url(context, `${this.definition.modelsPath ?? '/models'}?pageSize=200`),
      method: 'GET',
      headers: this.headers(context),
      timeoutMs: context.timeoutMs,
    });
    if (response.status < 200 || response.status >= 300) throw statusError(response.status);
    const entries = (response.body as { models?: unknown } | undefined)?.models;
    if (!Array.isArray(entries)) {
      throw new GatewayError(
        'GATEWAY_PROVIDER_ERROR',
        'The provider returned an unreadable model list.',
      );
    }
    const models: GatewayModel[] = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as Record<string, unknown>;
      // Gemini ids arrive as "models/<id>"; the API wants the bare id back.
      const rawName = typeof record.name === 'string' ? record.name : '';
      const id = rawName.startsWith('models/') ? rawName.slice('models/'.length) : rawName;
      if (!id) continue;
      const methods = Array.isArray(record.supportedGenerationMethods)
        ? (record.supportedGenerationMethods as unknown[]).filter(
            (m): m is string => typeof m === 'string',
          )
        : [];
      const canGenerate = methods.includes('generateContent');
      models.push({
        providerId: this.definition.id,
        modelId: id,
        displayName: typeof record.displayName === 'string' ? record.displayName : id,
        capabilities: [...this.definition.modelCapabilities],
        ...(typeof record.inputTokenLimit === 'number'
          ? { contextWindowTokens: record.inputTokenLimit }
          : {}),
        ...(typeof record.outputTokenLimit === 'number'
          ? { maxOutputTokens: record.outputTokenLimit }
          : {}),
        available: canGenerate,
        source: 'discovery',
      });
    }
    return models.sort((a, b) => a.modelId.localeCompare(b.modelId));
  }

  async generate(context: AdapterContext, request: AdapterRequest): Promise<AdapterResult> {
    const contents = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }],
      }));
    if (contents.length === 0) {
      throw new GatewayError('GATEWAY_INVALID_REQUEST', 'Gemini requires a user message.');
    }
    const body: Record<string, unknown> = { contents };
    const system = request.system ?? request.messages.find((m) => m.role === 'system')?.content;
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    const generationConfig: Record<string, unknown> = {};
    if (request.temperature !== undefined) generationConfig.temperature = request.temperature;
    if (request.maxOutputTokens !== undefined)
      generationConfig.maxOutputTokens = request.maxOutputTokens;
    if (request.structuredOutput) {
      if (!this.definition.capabilities.includes('structured-output')) {
        throw new GatewayError(
          'GATEWAY_CAPABILITY_UNSUPPORTED',
          'Gemini structured output is not enabled for this gateway.',
        );
      }
      generationConfig.responseMimeType = 'application/json';
      if (request.structuredOutput.schema) {
        generationConfig.responseSchema = request.structuredOutput.schema;
      }
    }
    if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;

    const modelPath = `${this.definition.generationPath.replace(/\/$/, '')}/${encodeURIComponent(
      request.modelId,
    )}:generateContent`;
    const response = await context.transport.request({
      url: this.url(context, modelPath),
      method: 'POST',
      headers: this.headers(context),
      body,
      timeoutMs: context.timeoutMs,
    });
    if (response.status < 200 || response.status >= 300)
      throw statusError(response.status, response.body);

    const payload = response.body as
      | {
          candidates?: unknown;
          usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown };
        }
      | undefined;
    const candidates = Array.isArray(payload?.candidates) ? payload?.candidates : [];
    const first = candidates[0] as
      { content?: { parts?: unknown }; finishReason?: unknown } | undefined;
    const parts = Array.isArray(first?.content?.parts) ? first?.content?.parts : [];
    const text = parts
      .map((part) =>
        part && typeof part === 'object' ? String((part as { text?: unknown }).text ?? '') : '',
      )
      .join('')
      .trim();
    if (text.length === 0) {
      throw new GatewayError(
        'GATEWAY_PROVIDER_ERROR',
        'The provider returned an empty completion.',
      );
    }
    return {
      content: text,
      finishReason: finishReasonOf(first?.finishReason),
      usage: {
        inputTokens:
          typeof payload?.usageMetadata?.promptTokenCount === 'number'
            ? payload.usageMetadata.promptTokenCount
            : null,
        outputTokens:
          typeof payload?.usageMetadata?.candidatesTokenCount === 'number'
            ? payload.usageMetadata.candidatesTokenCount
            : null,
      },
    };
  }

  /** Streams `:streamGenerateContent?alt=sse` frames as they arrive. */
  async *stream(context: AdapterContext, request: AdapterRequest): AsyncIterable<AdapterChunk> {
    if (!this.definition.capabilities.includes('streaming')) {
      throw new GatewayError(
        'GATEWAY_CAPABILITY_UNSUPPORTED',
        `${this.definition.displayName} does not support streaming.`,
      );
    }
    const contents = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }],
      }));
    if (contents.length === 0) {
      throw new GatewayError('GATEWAY_INVALID_REQUEST', 'Gemini requires a user message.');
    }
    const body: Record<string, unknown> = { contents };
    const system = request.system ?? request.messages.find((m) => m.role === 'system')?.content;
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    const generationConfig: Record<string, unknown> = {};
    if (request.temperature !== undefined) generationConfig.temperature = request.temperature;
    if (request.maxOutputTokens !== undefined)
      generationConfig.maxOutputTokens = request.maxOutputTokens;
    if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;

    const modelPath = `${this.definition.generationPath.replace(/\/$/, '')}/${encodeURIComponent(
      request.modelId,
    )}:streamGenerateContent`;
    const url = this.url(context, modelPath, { alt: 'sse' });
    const headers = { ...this.headers(context), accept: 'text/event-stream' };
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    let finish: AIFinishReason | undefined;

    const consume = function* (payload: unknown): Generator<AdapterChunk> {
      const record = payload as
        | {
            candidates?: unknown;
            usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown };
          }
        | undefined;
      const meta = record?.usageMetadata;
      if (typeof meta?.promptTokenCount === 'number') inputTokens = meta.promptTokenCount;
      if (typeof meta?.candidatesTokenCount === 'number') outputTokens = meta.candidatesTokenCount;
      const candidates = Array.isArray(record?.candidates) ? record?.candidates : [];
      const first = candidates[0] as
        { content?: { parts?: unknown }; finishReason?: unknown } | undefined;
      if (first?.finishReason !== undefined && first?.finishReason !== null) {
        finish = finishReasonOf(first.finishReason);
      }
      const parts = Array.isArray(first?.content?.parts) ? first.content.parts : [];
      const text = parts
        .map((part) =>
          part && typeof part === 'object' ? String((part as { text?: unknown }).text ?? '') : '',
        )
        .join('');
      if (text.length > 0) yield { delta: text, done: false };
    };

    if (context.transport.requestStream) {
      const events = context.transport.requestStream({
        url,
        method: 'POST',
        headers,
        body,
        timeoutMs: context.timeoutMs,
        ...(context.idleTimeoutMs !== undefined ? { idleTimeoutMs: context.idleTimeoutMs } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
      });
      for await (const frame of readSseEvents(events, {
        errorForStatus: (status: number) => statusError(status),
        ...(context.signal ? { signal: context.signal } : {}),
      })) {
        yield* consume(parseJsonFrame(frame.data));
      }
    } else {
      const response = await context.transport.request({
        url,
        method: 'POST',
        headers,
        body,
        timeoutMs: context.timeoutMs,
      });
      if (response.status < 200 || response.status >= 300) throw statusError(response.status);
      for (const line of response.text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        yield* consume(parseJsonFrame(trimmed.slice(5).trim()));
      }
    }
    yield {
      delta: '',
      done: true,
      usage: { inputTokens, outputTokens },
      ...(finish ? { finishReason: finish } : {}),
    };
  }
}
