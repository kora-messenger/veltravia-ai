import type { AIFinishReason } from '@veltravia/ai-core';

import { GatewayError } from '../errors/index.js';
import type { GatewayModel, ProviderDefinition } from '../types/index.js';
import { joinEndpoint } from '../ssrf/index.js';
import type {
  AdapterChunk,
  AdapterContext,
  AdapterRequest,
  AdapterResult,
  CredentialValidationResult,
  ProviderAdapter,
} from './adapter.js';
import { parseJsonFrame, readSseEvents } from './sse.js';

/**
 * Native Anthropic adapter (Messages API).
 *
 * Anthropic differs from the OpenAI shape in three ways this adapter handles
 * explicitly: the key travels in `x-api-key`, a version header is required, and
 * the system prompt is a top-level field rather than a message. Errors follow
 * the same normalized taxonomy as every other provider.
 */

const ANTHROPIC_VERSION = '2023-06-01';

function statusError(status: number): GatewayError {
  if (status === 401 || status === 403)
    return new GatewayError('GATEWAY_AUTH_FAILED', 'The provider rejected the API key.', {
      details: { status },
    });
  if (status === 404)
    return new GatewayError('GATEWAY_MODEL_UNKNOWN', 'The provider does not know that model.', {
      details: { status },
    });
  if (status === 429)
    return new GatewayError('GATEWAY_RATE_LIMITED', 'The provider is rate limiting this key.', {
      details: { status },
    });
  if (status === 400 || status === 422)
    return new GatewayError('GATEWAY_INVALID_REQUEST', 'The provider rejected the request.', {
      details: { status },
    });
  if (status >= 500)
    return new GatewayError('GATEWAY_PROVIDER_UNAVAILABLE', 'The provider is unavailable.', {
      details: { status },
    });
  return new GatewayError('GATEWAY_PROVIDER_ERROR', 'The provider rejected the request.', {
    details: { status },
  });
}

function finishReasonOf(raw: unknown): AIFinishReason {
  if (raw === 'end_turn' || raw === 'stop_sequence') return 'stop';
  if (raw === 'max_tokens') return 'length';
  if (raw === 'refusal') return 'content-filter';
  return 'unknown';
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly definition: ProviderDefinition;
  readonly supportsDiscovery: boolean;

  constructor(definition: ProviderDefinition) {
    this.definition = definition;
    this.supportsDiscovery = Boolean(definition.modelsPath);
  }

  private headers(context: AdapterContext): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-api-key': context.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    };
  }

  private url(context: AdapterContext, path: string): string {
    return joinEndpoint(new URL(context.baseUrl), path).toString();
  }

  async validateCredential(context: AdapterContext): Promise<CredentialValidationResult> {
    try {
      const models = await this.discoverModels(context);
      return { valid: true, models };
    } catch (error) {
      if (error instanceof GatewayError && error.code === 'GATEWAY_MODEL_UNKNOWN') {
        return { valid: true };
      }
      return {
        valid: false,
        errorCategory: error instanceof GatewayError ? error.code : 'GATEWAY_PROVIDER_ERROR',
      };
    }
  }

  async discoverModels(context: AdapterContext): Promise<readonly GatewayModel[]> {
    if (!this.definition.modelsPath) {
      throw new GatewayError(
        'GATEWAY_CAPABILITY_UNSUPPORTED',
        'This provider publishes no model list.',
      );
    }
    const response = await context.transport.request({
      url: this.url(context, this.definition.modelsPath),
      method: 'GET',
      headers: this.headers(context),
      timeoutMs: context.timeoutMs,
    });
    if (response.status < 200 || response.status >= 300) throw statusError(response.status);
    const entries = (response.body as { data?: unknown } | undefined)?.data;
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
      const id = typeof record.id === 'string' ? record.id : undefined;
      if (!id) continue;
      models.push({
        providerId: this.definition.id,
        modelId: id,
        displayName: typeof record.display_name === 'string' ? record.display_name : id,
        capabilities: [...this.definition.modelCapabilities],
        ...(typeof record.context_window === 'number'
          ? { contextWindowTokens: record.context_window }
          : {}),
        available: true,
        source: 'discovery',
      });
    }
    return models.sort((a, b) => a.modelId.localeCompare(b.modelId));
  }

  async generate(context: AdapterContext, request: AdapterRequest): Promise<AdapterResult> {
    const messages = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({ role: message.role, content: message.content }));
    if (messages.length === 0) {
      throw new GatewayError('GATEWAY_INVALID_REQUEST', 'Anthropic requires a user message.');
    }
    const body: Record<string, unknown> = {
      model: request.modelId,
      messages,
      max_tokens: request.maxOutputTokens ?? 1024,
    };
    const system = request.system ?? request.messages.find((m) => m.role === 'system')?.content;
    if (system) body.system = system;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.structuredOutput) {
      if (!this.definition.capabilities.includes('structured-output')) {
        throw new GatewayError(
          'GATEWAY_CAPABILITY_UNSUPPORTED',
          'Anthropic structured output is not enabled for this gateway.',
        );
      }
    }

    const response = await context.transport.request({
      url: this.url(context, this.definition.generationPath),
      method: 'POST',
      headers: this.headers(context),
      body,
      timeoutMs: context.timeoutMs,
    });
    if (response.status < 200 || response.status >= 300) throw statusError(response.status);

    const payload = response.body as
      | {
          content?: unknown;
          usage?: { input_tokens?: unknown; output_tokens?: unknown };
          stop_reason?: unknown;
        }
      | undefined;
    const blocks = Array.isArray(payload?.content) ? payload?.content : [];
    const text = blocks
      .map((block) =>
        block && typeof block === 'object' && (block as { type?: string }).type === 'text'
          ? String((block as { text?: unknown }).text ?? '')
          : '',
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
      finishReason: finishReasonOf(payload?.stop_reason),
      usage: {
        inputTokens:
          typeof payload?.usage?.input_tokens === 'number' ? payload.usage.input_tokens : null,
        outputTokens:
          typeof payload?.usage?.output_tokens === 'number' ? payload.usage.output_tokens : null,
      },
    };
  }

  /**
   * Streams the Messages API event protocol.
   *
   * Anthropic is event-typed rather than a delta string per choice:
   * message_start carries input tokens, content_block_delta carries text, and
   * message_delta carries the stop reason plus output tokens.
   */
  async *stream(context: AdapterContext, request: AdapterRequest): AsyncIterable<AdapterChunk> {
    if (!this.definition.capabilities.includes('streaming')) {
      throw new GatewayError(
        'GATEWAY_CAPABILITY_UNSUPPORTED',
        `${this.definition.displayName} does not support streaming.`,
      );
    }
    const messages = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({ role: message.role, content: message.content }));
    if (messages.length === 0) {
      throw new GatewayError('GATEWAY_INVALID_REQUEST', 'Anthropic requires a user message.');
    }
    const body: Record<string, unknown> = {
      model: request.modelId,
      messages,
      max_tokens: request.maxOutputTokens ?? 1024,
      stream: true,
    };
    const system = request.system ?? request.messages.find((m) => m.role === 'system')?.content;
    if (system) body.system = system;
    if (request.temperature !== undefined) body.temperature = request.temperature;

    const url = this.url(context, this.definition.generationPath);
    const headers = { ...this.headers(context), accept: 'text/event-stream' };
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    let finish: AIFinishReason | undefined;

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
        const parsed = parseJsonFrame(frame.data) as
          | {
              type?: unknown;
              message?: { usage?: { input_tokens?: unknown } };
              delta?: { text?: unknown; stop_reason?: unknown };
              usage?: { output_tokens?: unknown };
            }
          | undefined;
        if (parsed === undefined) continue;
        if (
          parsed.type === 'message_start' &&
          typeof parsed.message?.usage?.input_tokens === 'number'
        ) {
          inputTokens = parsed.message.usage.input_tokens;
        }
        if (parsed.type === 'content_block_delta' && typeof parsed.delta?.text === 'string') {
          if (parsed.delta.text.length > 0) yield { delta: parsed.delta.text, done: false };
        }
        if (parsed.type === 'message_delta') {
          if (typeof parsed.usage?.output_tokens === 'number')
            outputTokens = parsed.usage.output_tokens;
          if (parsed.delta?.stop_reason !== undefined && parsed.delta?.stop_reason !== null) {
            finish = finishReasonOf(parsed.delta.stop_reason);
          }
        }
        if (parsed.type === 'error') {
          throw new GatewayError('GATEWAY_PROVIDER_ERROR', 'The provider reported a stream error.');
        }
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
        const parsed = parseJsonFrame(trimmed.slice(5).trim()) as
          | {
              type?: unknown;
              message?: { usage?: { input_tokens?: unknown } };
              delta?: { text?: unknown; stop_reason?: unknown };
              usage?: { output_tokens?: unknown };
            }
          | undefined;
        if (parsed === undefined) continue;
        if (
          parsed.type === 'message_start' &&
          typeof parsed.message?.usage?.input_tokens === 'number'
        ) {
          inputTokens = parsed.message.usage.input_tokens;
        }
        if (parsed.type === 'content_block_delta' && typeof parsed.delta?.text === 'string') {
          if (parsed.delta.text.length > 0) yield { delta: parsed.delta.text, done: false };
        }
        if (parsed.type === 'message_delta') {
          if (typeof parsed.usage?.output_tokens === 'number')
            outputTokens = parsed.usage.output_tokens;
          if (parsed.delta?.stop_reason !== undefined && parsed.delta?.stop_reason !== null) {
            finish = finishReasonOf(parsed.delta.stop_reason);
          }
        }
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
