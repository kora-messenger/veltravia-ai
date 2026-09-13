import { describe, expect, it } from 'vitest';
import { AICore, AIProvider, ModelRegistry, type AIResponse } from '@veltravia/ai-core';
import {
  AgentModelError,
  extractDecisionJson,
  ModelDecisionSource,
  recordToolOutcome,
  validateAgentRequest,
} from './agent.js';
import { AgentNotFoundError, DuplicateAgentError } from './errors/index.js';
import { AgentRegistry, agentListEntry } from './registry/index.js';
import { resolveAgentExecutionLimits } from './limits/index.js';
import { CancellationController, asAgentCancellation } from './cancellation/index.js';
import { planConfirmationResume } from './confirmation/index.js';

// ---------------------------------------------------------------------------
// validateAgentRequest
// ---------------------------------------------------------------------------

describe('validateAgentRequest', () => {
  it('accepts a valid request', () => {
    expect(() =>
      validateAgentRequest({
        task: 'Explain what Veltravia AI is.',
        sessionId: 's1',
        projectId: 'p1',
        userId: 'u1',
        toolFilter: ['mock.summarize'],
        metadata: { source: 'test' },
      }),
    ).not.toThrow();
  });

  it('rejects empty and oversized tasks', () => {
    expect(() => validateAgentRequest({ task: '' })).toThrow(/task/);
    expect(() => validateAgentRequest({ task: 'x'.repeat(4001) })).toThrow(/4000/);
  });

  it('rejects oversized and malformed fields', () => {
    expect(() => validateAgentRequest({ task: 't', sessionId: 'x'.repeat(200) })).toThrow(
      /sessionId/,
    );
    expect(() => validateAgentRequest({ task: 't', toolFilter: ['ok', 42 as never] })).toThrow(
      /toolFilter/,
    );
    expect(() => validateAgentRequest({ task: 't', metadata: { huge: 'y'.repeat(5000) } })).toThrow(
      /metadata/,
    );
  });

  it('rejects secret-shaped metadata - secrets never enter agent requests', () => {
    expect(() =>
      validateAgentRequest({
        task: 't',
        metadata: { note: 'key ghp_AbCdEf1234567890AbCdEf1234567890AbCd' },
      }),
    ).toThrow(/secret-shaped/);
  });
});

// ---------------------------------------------------------------------------
// extractDecisionJson
// ---------------------------------------------------------------------------

describe('extractDecisionJson', () => {
  it('extracts the decision object from raw model text', () => {
    expect(extractDecisionJson('{"type":"answer","output":"hi"}')).toEqual({
      type: 'answer',
      output: 'hi',
    });
    expect(extractDecisionJson('```json\n{"type":"continue"}\n```')).toEqual({ type: 'continue' });
    expect(extractDecisionJson('Sure! Here is my decision: {"type":"stop"} hope it helps')).toEqual(
      { type: 'stop' },
    );
  });

  it('rejects empty, non-JSON, and object-free output', () => {
    expect(() => extractDecisionJson('')).toThrow(AgentModelError);
    expect(() => extractDecisionJson('no braces at all')).toThrow(AgentModelError);
    expect(() => extractDecisionJson('{broken json')).toThrow(AgentModelError);
  });
});

// ---------------------------------------------------------------------------
// ModelDecisionSource through the real AI Core (Agent -> AI Core -> Provider)
// ---------------------------------------------------------------------------

/** Mutable decision the fake provider will emit (proves the full Agent -> AI Core -> Provider path). */
let fakeDecision: object = { type: 'continue' };

/** A deterministic, offline provider that wraps the scripted decision in prose. */
const decisionProvider: AIProvider = {
  id: 'decision-fake',
  displayName: 'Decision Fake',
  async send(): Promise<AIResponse> {
    return {
      providerId: 'decision-fake',
      modelId: 'fake-decision-model',
      content: `Sure! Here is my decision.\n\n${JSON.stringify(fakeDecision)}`,
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  },
};

function decisionCore(): AICore {
  const registry = new ModelRegistry();
  registry.registerModel({
    modelId: 'fake-decision-model',
    providerId: 'decision-fake',
    displayName: 'Fake Decision Model',
    capabilities: ['text-generation'],
    contextWindowTokens: 4096,
    maxOutputTokens: 1024,
    available: true,
  });
  return new AICore({
    registry,
    providers: [decisionProvider],
    config: { defaultProvider: 'decision-fake' },
  });
}

describe('ModelDecisionSource', () => {
  const bareContext = {
    entries: [
      { role: 'user' as const, trust: 'user_input' as const, content: 'Explain Veltravia AI.' },
    ],
    tools: [],
    omittedToolResults: 0,
    limits: {},
    remainingIterations: 8,
  };

  it('routes through AI Core and parses the decision from model text', async () => {
    fakeDecision = { type: 'answer', output: 'done' };
    const source = new ModelDecisionSource(decisionCore());
    const decision = await source.decide(bareContext);
    expect(decision).toEqual({ type: 'answer', output: 'done' });
  });

  it('raises a typed model error for malformed model output', async () => {
    fakeDecision = { type: 'mischief' };
    const source = new ModelDecisionSource(decisionCore());
    await expect(source.decide(bareContext)).rejects.toThrow(/Invalid agent decision/);
  });
});

// ---------------------------------------------------------------------------
// recordToolOutcome
// ---------------------------------------------------------------------------

describe('recordToolOutcome', () => {
  it('refuses awaiting_confirmation results - they pause, never record', () => {
    expect(() =>
      recordToolOutcome({} as never, {
        invocationId: 'i',
        toolId: 't',
        status: 'awaiting_confirmation',
        requestedAt: 'x',
        completedAt: 'y',
      }),
    ).toThrow(/never recorded/);
  });
});

// ---------------------------------------------------------------------------
// registry, cancellation, confirmation planning
// ---------------------------------------------------------------------------

describe('AgentRegistry', () => {
  const fakeAgent = {
    id: 'agent.test',
    displayName: 'Test',
    description: 'd',
    execute: async () => ({ status: 'cancelled' as const }),
  };

  it('registers, retrieves, lists, and unregisters', () => {
    const registry = new AgentRegistry();
    registry.register(fakeAgent);
    expect(registry.has('agent.test')).toBe(true);
    expect(registry.get('agent.test')).toBe(fakeAgent);
    expect(registry.list()).toHaveLength(1);
    expect(agentListEntry(fakeAgent)).toEqual({
      id: 'agent.test',
      displayName: 'Test',
      description: 'd',
    });
    registry.unregister('agent.test');
    expect(registry.has('agent.test')).toBe(false);
  });

  it('rejects duplicates and unknown agents', () => {
    const registry = new AgentRegistry();
    registry.register(fakeAgent);
    expect(() => registry.register(fakeAgent)).toThrow(/already registered/);
    expect(() => registry.get('ghost')).toThrow(AgentNotFoundError);
  });
});

describe('CancellationController', () => {
  it('is a one-way flag', () => {
    const controller = new CancellationController();
    const cancellation = asAgentCancellation(controller);
    expect(cancellation.isRequested()).toBe(false);
    controller.request();
    expect(cancellation.isRequested()).toBe(true);
    controller.request(); // idempotent
    expect(cancellation.isRequested()).toBe(true);
  });
});

describe('planConfirmationResume', () => {
  it('maps decided confirmations to resume plans', () => {
    const pending = {
      confirmationId: 'c1',
      toolId: 'mock.purge',
      invocationId: 'i1',
      input: { confirmLabel: 'ok' },
    };
    expect(planConfirmationResume(pending, 'approved')).toEqual({ kind: 'execute' });
    const rejection = planConfirmationResume(pending, 'rejected');
    expect(rejection.kind).toBe('continue_with_denial');
    expect(rejection.kind === 'continue_with_denial' && rejection.message).toContain('rejected');
    expect(planConfirmationResume(pending, 'required')).toEqual({ kind: 'undecided' });
    expect(planConfirmationResume(pending, 'expired').kind).toBe('continue_with_denial');
  });
});

describe('limit validation wiring', () => {
  it('resolves caller limits with ceilings', () => {
    const limits = resolveAgentExecutionLimits({ maxIterations: 999 });
    expect(limits.maxIterations).toBe(50); // AGENT_LIMIT_CEILINGS.maxIterations
  });
});

describe('DuplicateAgentError', () => {
  it('is the typed duplicate error', () => {
    expect(new DuplicateAgentError('a').code).toBe('AGENT_DUPLICATE');
  });
});
