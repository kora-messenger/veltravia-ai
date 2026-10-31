import type { AIFinishReason } from '@veltravia/ai-core';

import { GatewayError } from '../errors/index.js';
import { redact, summarizeProviderMessage } from '../security/index.js';
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
import type { TransportResponse } from './transport.js';

/**
 * The reusable OpenAI-compatible adapter.
 *
 * Many vendors expose the same `/chat/completions` + `/models` shape, but they
 * do NOT all implement the same features. So the adapter is driven entirely by
 * the provider DEFINITION: base URL, auth format, paths, declared capabilities
 * and timeout. Anything a provider does not declare is never sent and never
 * advertised - structured output, vision and streaming are decided per provider,
 * not assumed.
 */

export type OpenAIAuthFormat = 'bearer' | 'x-api-key' | 'query-key';

interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string | readonly unknown[];
}

const ERROR_STATUS: Readonly<Record<number, [string, string]>> = {
  400: ['GATEWAY_INVALID_REQUEST', 'The provider rejected the request.'],
  401: ['GATEWAY_AUTH_FAILED', 'The provider rejected the API key.'],
  403: ['GATEWAY_AUTH_FAILED', 'The provider refused access for this key.'],
  404: ['GATEWAY_MODEL_UNKNOWN', 'The provider does not know that model or endpoint.'],
  413: ['GATEWAY_LIMIT_EXCEEDED', 'The request was too large for the provider.'],
  422: ['GATEWAY_INVALID_REQUEST', 'The provider rejected the request.'],
  429: ['GATEWAY_RATE_LIMITED', 'The provider is rate limiting this key.'],
};

function normalizedFor(status: number, rawMessage: string): GatewayError {
  const mapped = ERROR_STATUS[status];
  if (mapped) {
    const [code, message] = mapped as [string, string];
    return new GatewayError(code as GatewayError['code'], message, {
      details: { status },
    });
  }
  if (status === 402) {
    return new GatewayError('GATEWAY_LIMIT_EXCEEDED', 'The provider reports no remaining credit.', {
      details: { status },
    });
  }
  if (status >= 500) {
    return new GatewayError('GATEWAY_PROVIDER_UNAVAILABLE', 'The provider is unavailable.', {
      details: { status },
    });
  }
  if (status >= 300 && status < 400) {
    return new GatewayError('GATEWAY_PROVIDER_ERROR', 'The provider redirected the request.', {
      details: { status },
    });
  }
  const summary = summarizeProviderMessage(rawMessage);
  return new GatewayError(
    'GATEWAY_PROVIDER_ERROR',
    summary || 'The provider rejected the request.',
    {
      details: { status },
    },
  );
}

function providerMessage(response: TransportResponse): string {
  const body = response.body;
  if (body && typeof body === 'object') {
    const error = (body as { error?: unknown }).error;
    if (typeof error === 'string') return error;
    if (error && typeof error === 'object') {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string') return message;
    }
  }
  return response.text.slice(0, 200);
}

function finishReasonOf(raw: unknown): AIFinishReason {
  if (raw === 'stop') return 'stop';
  if (raw === 'length' || raw === 'max_tokens') return 'length';
  if (raw === 'content_filter') return 'content-filter';
  if (raw === 'error') return 'error';
  return 'unknown';
}

function usageOf(body: unknown): { inputTokens: number | null; outputTokens: number | null } {
  const usage = (body as { usage?: Record<string, unknown> } | undefined)?.usage;
  const prompt = usage?.prompt_tokens ?? usage?.input_tokens;
  const completion = usage?.completion_tokens ?? usage?.output_tokens;
  return {
    inputTokens: typeof prompt === 'number' ? prompt : null,
    outputTokens: typeof completion === 'number' ? completion : null,
  };
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly definition: ProviderDefinition;
  readonly supportsDiscovery: boolean;

  constructor(definition: ProviderDefinition) {
    this.definition = definition;
    this.supportsDiscovery = Boolean(definition.modelsPath);
  }

  private headers(context: AdapterContext): Record<string, string> {
    const format = context.authFormatOverride ?? this.definition.auth;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
    };
    if (format === 'bearer') headers.authorization = `Bearer ${context.apiKey}`;
    else if (format === 'x-api-key') headers['x-api-key'] = context.apiKey;
    return headers;
  }

  private url(context: AdapterContext, path: string, query?: Record<string, string>): string {
    const base = new URL(context.baseUrl);
    const joined = joinEndpoint(base, path);
    const format = context.authFormatOverride ?? this.definition.auth;
    if (format === 'query-key')
      joined.searchParams.set(this.definition.authParameter || 'key', context.apiKey);
    for (const [key, value] of Object.entries(query ?? {})) joined.searchParams.set(key, value);
    return joined.toString();
  }

  async validateCredential(context: AdapterContext): Promise<CredentialValidationResult> {
    if (this.definition.modelsPath) {
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
    // No discovery endpoint: a one-token generation is the cheapest honest check.
    try {
      await this.generate(context, {
        modelId: context.apiKey ? '__validation__' : '__validation__',
        messages: [{ role: 'user', content: 'ping' }],
        maxOutputTokens: 1,
      });
      return { valid: true };
    } catch (error) {
      if (error instanceof GatewayError && error.code === 'GATEWAY_MODEL_UNKNOWN') {
        // The credential was accepted; the model id was not. That is still a
        // valid credential, so report success without model claims.
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
        `${this.definition.displayName} does not publish a model list. Add model ids manually.`,
      );
    }
    const response = await context.transport.request({
      url: this.url(context, this.definition.modelsPath),
      method: 'GET',
      headers: this.headers(context),
      timeoutMs: context.timeoutMs,
    });
    if (response.status < 200 || response.status >= 300) {
      throw normalizedFor(response.status, providerMessage(response));
    }
    const entries = (response.body as { data?: unknown } | undefined)?.data;
    if (!Array.isArray(entries)) {
      throw new GatewayError(
        'GATEWAY_PROVIDER_ERROR',
        `${this.definition.displayName} returned a model list this adapter does not understand.`,
      );
    }
    const models: GatewayModel[] = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as Record<string, unknown>;
      const id = typeof record.id === 'string' ? record.id : undefined;
      if (!id) continue;
      const contextWindow =
        typeof record.context_length === 'number'
          ? record.context_length
          : typeof record.context_window === 'number'
            ? record.context_window
            : undefined;
      models.push({
        providerId: this.definition.id,
        modelId: id,
        displayName: typeof record.name === 'string' && record.name.length > 0 ? record.name : id,
        capabilities: [...this.definition.modelCapabilities],
        ...(contextWindow !== undefined ? { contextWindowTokens: contextWindow } : {}),
        available: true,
        source: 'discovery',
      });
    }
    return models.sort((a, b) => a.modelId.localeCompare(b.modelId));
  }

  private body(request: AdapterRequest): Record<string, unknown> {
    const messages: ChatMessage[] = [];
    if (request.system) messages.push({ role: 'system', content: request.system });
    for (const message of request.messages)
      messages.push({ role: message.role, content: message.content });
    const body: Record<string, unknown> = { model: request.modelId, messages };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.maxOutputTokens !== undefined) body.max_tokens = request.maxOutputTokens;
    if (request.structuredOutput) {
      if (!this.definition.capabilities.includes('structured-output')) {
        throw new GatewayError(
          'GATEWAY_CAPABILITY_UNSUPPORTED',
          `${this.definition.displayName} does not support structured output.`,
        );
      }
      body.response_format = { type: 'json_object' };
    }
    return body;
  }

  async generate(context: AdapterContext, request: AdapterRequest): Promise<AdapterResult> {
    const body = this.body(request);
    if (
      request.requiredCapabilities?.includes('vision') &&
      !this.definition.capabilities.includes('vision')
    ) {
      throw new GatewayError(
        'GATEWAY_CAPABILITY_UNSUPPORTED',
        `${this.definition.displayName} cannot accept images through this gateway.`,
      );
    }
    const response = await context.transport.request({
      url: this.url(context, this.definition.generationPath),
      method: 'POST',
      headers: this.headers(context),
      body,
      timeoutMs: context.timeoutMs,
    });
    if (response.status < 200 || response.status >= 300) {
      throw normalizedFor(response.status, providerMessage(response));
    }
    const choice = (response.body as { choices?: unknown } | undefined)?.choices;
    if (!Array.isArray(choice) || choice.length === 0) {
      throw new GatewayError('GATEWAY_PROVIDER_ERROR', 'The provider returned no completion.');
    }
    const first = choice[0] as { message?: { content?: unknown }; finish_reason?: unknown };
    const content = typeof first.message?.content === 'string' ? first.message.content : '';
    if (content.length === 0) {
      throw new GatewayError(
        'GATEWAY_PROVIDER_ERROR',
        'The provider returned an empty completion.',
      );
    }
    return {
      content,
      finishReason: finishReasonOf(first.finish_reason),
      usage: usageOf(response.body),
    };
  }

  async *stream(context: AdapterContext, request: AdapterRequest): AsyncIterable<AdapterChunk> {
    if (!this.definition.capabilities.includes('streaming')) {
      throw new GatewayError(
        'GATEWAY_CAPABILITY_UNSUPPORTED',
        `${this.definition.displayName} does not support streaming.`,
      );
    }
    const body = { ...this.body(request), stream: true };
    const response = await context.transport.request({
      url: this.url(context, this.definition.generationPath),
      method: 'POST',
      headers: { ...this.headers(context), accept: 'text/event-stream' },
      body,
      timeoutMs: context.timeoutMs,
    });
    if (response.status < 200 || response.status >= 300) {
      throw normalizedFor(response.status, providerMessage(response));
    }
    for (const line of response.text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') {
        yield { delta: '', done: true };
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
      const choice = (parsed as { choices?: unknown }).choices;
      if (!Array.isArray(choice) || choice.length === 0) continue;
      const delta = (choice[0] as { delta?: { content?: unknown } }).delta?.content;
      if (typeof delta === 'string' && delta.length > 0) yield { delta, done: false };
    }
    yield { delta: '', done: true };
  }
}

/** Scrubs any provider text before it is attached to a diagnostic message. */
export function scrubProviderText(text: string): string {
  return redact(text);
}
