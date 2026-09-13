import { describe, expect, it } from 'vitest';
import { AIProviderError } from '@veltravia/ai-core';
import type { AIModelInfo, AIRequest } from '@veltravia/ai-core';
import { resolveGeminiConfig } from './config';
import {
  extractOutputText,
  fromGeminiInteraction,
  mapFinishReason,
  mapGeminiUsage,
  toGeminiInteraction,
} from './mapping';

const config = resolveGeminiConfig({ apiKey: 'test-key' });
const model: AIModelInfo = {
  providerId: 'gemini',
  modelId: 'gemini-3.8-flash',
  capabilities: ['text-generation'],
  available: true,
};
const now = () => new Date('2026-09-13T10:00:00.000Z');

describe('toGeminiInteraction (request mapping)', () => {
  it('maps a single-turn request to a user_input step', () => {
    const request: AIRequest = { messages: [{ role: 'user', content: 'Hello Gemini' }] };
    const body = toGeminiInteraction(request, model, config);
    expect(body.model).toBe('gemini-3.8-flash');
    expect(body.input).toEqual([
      { type: 'user_input', content: [{ type: 'text', text: 'Hello Gemini' }] },
    ]);
    expect(body.store).toBe(false);
    expect(body.system_instruction).toBeUndefined();
    expect(body.response_format).toBeUndefined();
  });

  it('maps multi-turn conversations to user_input/model_output steps in order', () => {
    const request: AIRequest = {
      messages: [
        { role: 'user', content: 'Hi, my name is Ijezie.' },
        { role: 'assistant', content: 'Hello Ijezie, how can I help?' },
        { role: 'user', content: 'What is my name?' },
      ],
    };
    const steps = toGeminiInteraction(request, model, config).input as { type: string }[];
    expect(steps.map((step) => step.type)).toEqual(['user_input', 'model_output', 'user_input']);
  });

  it('merges request.system and system-role messages into system_instruction', () => {
    const request: AIRequest = {
      system: 'Be terse.',
      messages: [
        { role: 'system', content: 'Always answer in English.' },
        { role: 'user', content: 'Hi' },
      ],
    };
    const body = toGeminiInteraction(request, model, config);
    expect(body.system_instruction).toBe('Be terse.\n\nAlways answer in English.');
    // System messages must NOT become conversation steps.
    expect((body.input as { type: string }[]).map((s) => s.type)).toEqual(['user_input']);
  });

  it('maps structured output to a JSON response_format', () => {
    const request: AIRequest = {
      messages: [{ role: 'user', content: 'Give me JSON' }],
      structuredOutput: { name: 'answer', schema: { type: 'object' } },
    };
    const body = toGeminiInteraction(request, model, config);
    expect(body.response_format).toEqual({
      type: 'text',
      mime_type: 'application/json',
      schema: { type: 'object' },
    });
  });

  it('maps sampling and token limits into generation_config', () => {
    const request: AIRequest = {
      messages: [{ role: 'user', content: 'Hi' }],
      temperature: 0.4,
      maxOutputTokens: 1024,
    };
    const body = toGeminiInteraction(request, model, config);
    expect(body.generation_config).toMatchObject({
      temperature: 0.4,
      max_output_tokens: 1024,
    });
  });

  it('forwards the configured thinking level and store flag', () => {
    const cfg = resolveGeminiConfig({ apiKey: 'k', thinkingLevel: 'low', storeInteractions: true });
    const body = toGeminiInteraction({ messages: [{ role: 'user', content: 'Hi' }] }, model, cfg);
    expect(body.generation_config).toMatchObject({ thinking_level: 'low' });
    expect(body.store).toBe(true);
  });

  it('supports the future stateful hook without changing the request model', () => {
    const body = toGeminiInteraction(
      { messages: [{ role: 'user', content: 'Hi' }] },
      model,
      config,
      { previousInteractionId: 'int_123' },
    );
    expect(body.previous_interaction_id).toBe('int_123');
  });
});

describe('fromGeminiInteraction (response mapping)', () => {
  const okInteraction = {
    id: 'int_abc',
    status: 'completed',
    usage: { total_input_tokens: 8, total_output_tokens: 12, total_tokens: 20 },
    created: '2026-09-13T09:00:00.000Z',
    steps: [
      { type: 'thought' },
      {
        type: 'model_output',
        content: [
          { type: 'text', text: 'Hello ' },
          { type: 'text', text: 'Veltravia!' },
        ],
      },
    ],
  };

  it('maps a completed interaction into a normalized AIResponse', () => {
    const response = fromGeminiInteraction(okInteraction, model, undefined, now);
    expect(response.content).toBe('Hello \nVeltravia!');
    expect(response.providerId).toBe('gemini');
    expect(response.modelId).toBe('gemini-3.8-flash');
    expect(response.requestId).toBe('int_abc');
    expect(response.generatedAt).toBe('2026-09-13T09:00:00.000Z');
    expect(response.finishReason).toBe('stop');
  });

  it('joins text blocks across model_output steps with newlines', () => {
    const interaction = {
      id: 'int_2',
      status: 'completed',
      steps: [
        { type: 'model_output', content: [{ type: 'text', text: 'First' }] },
        { type: 'model_output', content: [{ type: 'text', text: 'Second' }] },
      ],
    };
    expect(extractOutputText(interaction)).toBe('First\nSecond');
  });

  it('falls back to the SDK output_text convenience when steps are absent', () => {
    const interaction = { id: 'int_3', status: 'completed' };
    const response = fromGeminiInteraction(interaction, model, 'convenience text', now);
    expect(response.content).toBe('convenience text');
  });

  it('throws a malformed AIProviderError when there is no output at all', () => {
    const interaction = { id: 'int_4', status: 'completed', steps: [{ type: 'thought' }] };
    expect(() => fromGeminiInteraction(interaction, model, undefined, now)).toThrow(
      AIProviderError,
    );
    expect(() => fromGeminiInteraction(interaction, model, undefined, now)).toThrow(
      /no model output/,
    );
  });

  it('throws a malformed AIProviderError when the interaction has no id', () => {
    const interaction = {
      status: 'completed',
      steps: [{ type: 'model_output', content: [{ type: 'text', text: 'x' }] }],
    };
    expect(() => fromGeminiInteraction(interaction, model, undefined, now)).toThrow(
      /missing an interaction id/,
    );
  });

  it('surfaces failed/cancelled interactions as typed provider errors', () => {
    const failed = { ...okInteraction, status: 'failed' };
    expect(() => fromGeminiInteraction(failed, model, undefined, now)).toThrow(/failed/);
  });
});

describe('usage mapping', () => {
  it('maps all reported token fields', () => {
    const usage = mapGeminiUsage({
      total_input_tokens: 5,
      total_output_tokens: 7,
      total_tokens: 12,
    });
    expect(usage).toEqual({ inputTokens: 5, outputTokens: 7, totalTokens: 12 });
  });

  it('represents missing fields as undefined - never fabricates values', () => {
    const usage = mapGeminiUsage({ total_tokens: 9 });
    expect(usage).toEqual({ inputTokens: undefined, outputTokens: undefined, totalTokens: 9 });
  });

  it('returns null when Gemini reports nothing', () => {
    expect(mapGeminiUsage(undefined)).toBeNull();
    expect(mapGeminiUsage({})).toBeNull();
  });
});

describe('finish reason mapping', () => {
  it('classifies interaction statuses deterministically', () => {
    expect(mapFinishReason('completed')).toBe('stop');
    expect(mapFinishReason('incomplete')).toBe('length');
    expect(mapFinishReason('budget_exceeded')).toBe('length');
    expect(mapFinishReason('failed')).toBe('error');
    expect(mapFinishReason('cancelled')).toBe('error');
    expect(mapFinishReason('requires_action')).toBe('unknown');
    expect(mapFinishReason(undefined)).toBe('unknown');
  });
});
