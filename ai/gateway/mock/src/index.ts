import { randomBytes } from 'node:crypto';

import type {
  ProviderTransport,
  TransportRequest,
  TransportResponse,
  VaultKeyring,
} from '@veltravia/ai-gateway';

/**
 * Deterministic fixtures for tests and offline CI. Nothing here touches a
 * socket, and no real key is ever used.
 */

/** A keyring built from random bytes (32-byte AES-256 keys). */
export function createTestKeyring(versions: readonly number[] = [1]): VaultKeyring {
  const keys = new Map<number, Buffer>();
  for (const version of versions) keys.set(version, randomBytes(32));
  const sorted = [...keys.keys()].sort((a, b) => a - b);
  return { keys, activeVersion: sorted[sorted.length - 1] as number };
}

export const TEST_OPENAI_KEY = 'sk-test-openai-0000000000000000';
export const TEST_ANTHROPIC_KEY = 'sk-ant-test-0000000000000000';
export const TEST_GEMINI_KEY = 'AIzaTest000000000000000000000000000';
export const TEST_CUSTOM_KEY = 'custom-test-key-0000000000';

export function modelsResponse(
  ids: readonly string[] = ['gpt-test-mini', 'gpt-test-large'],
): TransportResponse {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: { data: ids.map((id) => ({ id, object: 'model' })) },
    text: '',
  };
}

export function chatResponse(
  content = 'Hello from the fixture provider.',
  usage: { prompt_tokens?: number; completion_tokens?: number } = {
    prompt_tokens: 12,
    completion_tokens: 7,
  },
): TransportResponse {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: {
      id: 'chatcmpl-fixture',
      choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage,
    },
    text: '',
  };
}

export function anthropicResponse(content = 'Hello from Anthropic.'): TransportResponse {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: {
      id: 'msg_fixture',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: content }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 21, output_tokens: 9 },
    },
    text: '',
  };
}

export function geminiResponse(content = 'Hello from Gemini.'): TransportResponse {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: {
      candidates: [{ content: { parts: [{ text: content }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 6 },
    },
    text: '',
  };
}

export function errorResponse(status: number, message = 'provider said no'): TransportResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: { error: { message } },
    text: JSON.stringify({ error: { message } }),
  };
}

export interface FixtureTransportOptions {
  readonly models?: readonly string[];
  readonly content?: string;
  readonly status?: number;
  readonly errorMessage?: string;
  /** Called for every request; return a response to override the default. */
  readonly override?: (request: TransportRequest) => TransportResponse | undefined;
}

/** A complete fake provider: model list + chat / messages / generateContent. */
export class FixtureProviderTransport implements ProviderTransport {
  readonly requests: TransportRequest[] = [];
  private readonly options: FixtureTransportOptions;

  constructor(options: FixtureTransportOptions = {}) {
    this.options = options;
  }

  async request(request: TransportRequest): Promise<TransportResponse> {
    this.requests.push(request);
    const override = this.options.override?.(request);
    if (override) return override;
    if (this.options.status && this.options.status >= 300) {
      return errorResponse(this.options.status, this.options.errorMessage);
    }
    const url = request.url;
    if (request.method === 'GET') {
      if (url.includes('generativelanguage')) {
        const ids = this.options.models ?? ['gemini-test-flash'];
        return {
          status: 200,
          headers: {},
          body: {
            models: ids.map((id) => ({
              name: `models/${id}`,
              displayName: id,
              supportedGenerationMethods: ['generateContent'],
              inputTokenLimit: 1000000,
            })),
          },
          text: '',
        };
      }
      if (url.includes('anthropic')) {
        const ids = this.options.models ?? ['claude-test-1'];
        return {
          status: 200,
          headers: {},
          body: { data: ids.map((id) => ({ id, display_name: id })) },
          text: '',
        };
      }
      return modelsResponse(this.options.models ?? ['gpt-test-mini']);
    }
    if (url.includes('anthropic')) return anthropicResponse(this.options.content);
    if (url.includes('generativelanguage')) return geminiResponse(this.options.content);
    return chatResponse(this.options.content);
  }
}
