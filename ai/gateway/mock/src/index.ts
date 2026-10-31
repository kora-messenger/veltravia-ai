import { randomBytes } from 'node:crypto';

import type {
  ProviderTransport,
  TransportRequest,
  TransportResponse,
  TransportStreamEvent,
  TransportStreamRequest,
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
  /** Pieces a streamed answer is split into. Defaults to word-ish slices. */
  readonly streamChunks?: readonly string[];
  /** Throws the given error mid-stream, to test interrupted streams. */
  readonly streamFailure?: Error;
  /** Usage the stream reports on its final frame. Omit to report none. */
  readonly streamUsage?: { readonly inputTokens?: number; readonly outputTokens?: number };
  /** Abort after this many chunks, simulating a provider that stops mid-answer. */
  readonly streamStallAfter?: number;
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

  /**
   * Offline incremental path. Emits the real SSE shapes per vendor, so adapter
   * parsers are exercised exactly as they would be against a live provider -
   * without a socket and without a key.
   */
  async *requestStream(request: TransportStreamRequest): AsyncIterable<TransportStreamEvent> {
    this.requests.push(request as unknown as TransportRequest);
    // An override is the fixture's source of truth: if it supplies SSE text,
    // that text is streamed frame by frame instead of the generated default.
    const overridden = this.options.override?.(request as TransportRequest);
    const status = overridden?.status ?? this.options.status ?? 200;
    yield { type: 'head', status, headers: { 'content-type': 'text/event-stream' } };
    if (status < 200 || status >= 300) return;
    const supplied = overridden?.text;
    if (supplied !== undefined && supplied.length > 0) {
      for (const frame of supplied.split(/\n\n/)) {
        if (frame.trim().length === 0) continue;
        if (request.signal?.aborted === true) return;
        yield { type: 'chunk', text: `${frame}\n\n` };
      }
      return;
    }
    // A fixture override that answers with a normal JSON completion still has to
    // work when the caller asked to stream: replay its content as one fragment
    // and its usage as a final report, rather than inventing different text.
    const buffered = overridden?.body as
      | {
          choices?: { message?: { content?: string } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        }
      | undefined;
    const bufferedContent = buffered?.choices?.[0]?.message?.content;
    if (typeof bufferedContent === 'string') {
      if (bufferedContent.length > 0) yield { type: 'chunk', text: bufferedContent };
      const usage =
        buffered?.usage?.prompt_tokens !== undefined &&
        buffered.usage.completion_tokens !== undefined
          ? {
              inputTokens: buffered.usage.prompt_tokens,
              outputTokens: buffered.usage.completion_tokens,
            }
          : undefined;
      yield {
        type: 'chunk',
        text: '',
        done: true as const,
        ...(usage !== undefined ? { usage } : {}),
      } as never;
      return;
    }
    const url = request.url;
    const chunks =
      this.options.streamChunks ?? splitForStreaming(this.options.content ?? DEFAULT_STREAM_TEXT);
    for (const [index, piece] of chunks.entries()) {
      if (request.signal?.aborted === true) return;
      if (this.options.streamFailure && index === 1) throw this.options.streamFailure;
      if (this.options.streamStallAfter !== undefined && index === this.options.streamStallAfter) {
        return;
      }
      yield { type: 'chunk', text: frameFor(url, piece, this.options) };
    }
    yield { type: 'chunk', text: closingFrameFor(url, this.options) };
  }
}

const DEFAULT_STREAM_TEXT = 'Streamed fixture answer from the offline transport.';

/** Splits a message into word-sized pieces, keeping the spaces. */
export function splitForStreaming(text: string): string[] {
  const parts = text.match(/\S+\s*/g);
  return parts === null || parts.length === 0 ? [text] : parts;
}

function frameFor(url: string, piece: string, options: FixtureTransportOptions): string {
  const usage = options.streamUsage;
  if (url.includes('anthropic')) {
    const event = {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: piece },
    };
    return `event: content_block_delta\ndata: ${JSON.stringify(event)}\n\n`;
  }
  if (url.includes('generativelanguage')) {
    const payload = { candidates: [{ content: { parts: [{ text: piece }] } }] };
    return `data: ${JSON.stringify(payload)}\n\n`;
  }
  const payload = {
    choices: [{ delta: { content: piece }, finish_reason: null }],
    ...(usage
      ? {
          usage: {
            prompt_tokens: usage.inputTokens ?? 0,
            completion_tokens: usage.outputTokens ?? 0,
          },
        }
      : {}),
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function closingFrameFor(url: string, options: FixtureTransportOptions): string {
  const usage = options.streamUsage;
  if (url.includes('anthropic')) {
    const start = {
      type: 'message_start',
      message: { usage: { input_tokens: usage?.inputTokens ?? null } },
    };
    const delta = {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: usage?.outputTokens ?? null },
    };
    return (
      `event: message_start\ndata: ${JSON.stringify(start)}\n\n` +
      `event: message_delta\ndata: ${JSON.stringify(delta)}\n\n` +
      `event: message_stop\ndata: {}\n\n`
    );
  }
  if (url.includes('generativelanguage')) {
    const payload = {
      candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'STOP' }],
      ...(usage
        ? {
            usageMetadata: {
              promptTokenCount: usage.inputTokens ?? 0,
              candidatesTokenCount: usage.outputTokens ?? 0,
            },
          }
        : {}),
    };
    return `data: ${JSON.stringify(payload)}\n\n`;
  }
  const final = {
    choices: [{ delta: {}, finish_reason: 'stop' }],
    ...(usage
      ? {
          usage: {
            prompt_tokens: usage.inputTokens ?? 0,
            completion_tokens: usage.outputTokens ?? 0,
          },
        }
      : {}),
  };
  return `data: ${JSON.stringify(final)}\n\ndata: [DONE]\n\n`;
}
