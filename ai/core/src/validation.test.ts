import { describe, expect, it } from 'vitest';
import { InvalidAIRequestError } from './errors';
import { resolveAIConfig } from './config';
import { validateAIRequest } from './validation';

const config = resolveAIConfig();

const validRequest = {
  messages: [{ role: 'user', content: 'hello' }],
};

describe('validateAIRequest', () => {
  it('accepts a valid request and returns it unchanged in shape', () => {
    const request = validateAIRequest(validRequest, config);
    expect(request.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('keeps optional fields when present', () => {
    const request = validateAIRequest(
      {
        ...validRequest,
        system: 'be brief',
        model: 'mock-text-small',
        capabilities: ['text-generation'],
        temperature: 0.7,
        maxOutputTokens: 512,
        structuredOutput: { name: 'answer' },
      },
      config,
    );
    expect(request.system).toBe('be brief');
    expect(request.model).toBe('mock-text-small');
    expect(request.temperature).toBe(0.7);
    expect(request.maxOutputTokens).toBe(512);
  });

  it('rejects non-objects outright', () => {
    expect(() => validateAIRequest('nope', config)).toThrow(InvalidAIRequestError);
    expect(() => validateAIRequest(null, config)).toThrow(InvalidAIRequestError);
  });

  it('rejects empty or missing messages', () => {
    expect(() => validateAIRequest({ messages: [] }, config)).toThrow(InvalidAIRequestError);
    expect(() => validateAIRequest({}, config)).toThrow(/messages/);
  });

  it('rejects invalid roles and empty content', () => {
    const bad = validateAIRequest; // eslint sees unused otherwise? no - keep direct
    expect(() => bad({ messages: [{ role: 'robot', content: 'hi' }] }, config)).toThrow(/role/);
    expect(() => bad({ messages: [{ role: 'user', content: '' }] }, config)).toThrow(/content/);
  });

  it('collects every issue into the error details', () => {
    try {
      validateAIRequest({ messages: [], temperature: 99, model: '' }, config);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidAIRequestError);
      const details = (error as InvalidAIRequestError).details as { issues: string[] };
      expect(details.issues.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('enforces configured message-count and character limits', () => {
    const strict = resolveAIConfig({ maxInputMessages: 2, maxInputChars: 10 });
    const messages = [
      { role: 'user', content: 'one' },
      { role: 'user', content: 'two' },
      { role: 'user', content: 'three' },
    ];
    expect(() => validateAIRequest({ messages }, strict)).toThrow(/at most 2 messages/);
    expect(() =>
      validateAIRequest({ messages: [{ role: 'user', content: 'a'.repeat(11) }] }, strict),
    ).toThrow(/exceeds 10 characters/);
  });

  it('rejects unknown capabilities', () => {
    expect(() =>
      validateAIRequest({ ...validRequest, capabilities: ['telepathy'] }, config),
    ).toThrow(/capability/);
  });

  it('rejects out-of-range temperature and bad token limits', () => {
    expect(() => validateAIRequest({ ...validRequest, temperature: 3 }, config)).toThrow(
      /temperature/,
    );
    expect(() => validateAIRequest({ ...validRequest, maxOutputTokens: 0 }, config)).toThrow(
      /maxOutputTokens/,
    );
  });
});
