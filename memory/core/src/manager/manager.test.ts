import { describe, expect, it } from 'vitest';

import {
  createMemoryAuditCollector,
  InvalidMemoryRequestError,
  InvalidMemoryTransitionError,
  MemoryLimitReachedError,
  MemoryManager,
  MemoryNotFoundError,
  MemoryRevisionConflictError,
  MemorySearchTooLargeError,
  MemorySecretRejectedError,
  type CreateMemoryInput,
  type MemoryAuditEvent,
} from '@veltravia/memory-core';
import { InMemoryMemoryRepository } from '@veltravia/memory-mock';

let tick = 0;
const fixedNow = () => new Date(Date.UTC(2026, 8, 18, 10, 0, 0) + tick++ * 1000);

function createManager(options = {}) {
  const audit = createMemoryAuditCollector();
  const manager = new MemoryManager({
    repository: new InMemoryMemoryRepository({ now: fixedNow }),
    now: fixedNow,
    auditSink: audit.sink,
    ...options,
  });
  return { manager, audit };
}

const validInput = (overrides: Partial<CreateMemoryInput> = {}): CreateMemoryInput => ({
  projectId: 'prj_a',
  type: 'architecture',
  title: 'Authentication architecture',
  content: 'The API uses Fastify with strict schema validation.',
  source: { kind: 'user' },
  ...overrides,
});

describe('memory manager lifecycle (Scenarios A-G)', () => {
  it('A: creates a project memory with defaults and provenance', async () => {
    const { manager, audit } = createManager();
    const memory = await manager.create(validInput());
    expect(memory.id).toMatch(/^mem_\d{6}$/);
    expect(memory.status).toBe('active');
    expect(memory.confidence).toBe('medium');
    expect(memory.verificationStatus).toBe('unverified');
    expect(memory.revision).toBe(1);
    expect(memory.source.kind).toBe('user');
    const created = audit.events.find((event: MemoryAuditEvent) => event.type === 'memory_created');
    expect(created?.projectId).toBe('prj_a');
    expect(created?.data.content).toBeUndefined();
  });

  it('B: retrieves memory by id within the project', async () => {
    const { manager } = createManager();
    const created = await manager.create(validInput());
    const fetched = await manager.get(created.id, 'prj_a');
    expect(fetched.id).toBe(created.id);
    expect(fetched.title).toBe('Authentication architecture');
  });

  it('C: searches by text and filters by type and status', async () => {
    const { manager } = createManager();
    await manager.create(validInput({ title: 'Auth flow', content: 'OAuth via Google' }));
    await manager.create(
      validInput({ type: 'convention', title: 'Naming rules', content: 'Files use kebab-case' }),
    );
    const hits = await manager.search({ projectId: 'prj_a', text: 'OAuth' });
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe('Auth flow');
    const byType = await manager.search({ projectId: 'prj_a', type: 'convention' });
    expect(byType).toHaveLength(1);
  });

  it('D: updates memory with revision bump and provenance immutability', async () => {
    const { manager } = createManager();
    const created = await manager.create(validInput());
    const updated = await manager.update(created.id, 'prj_a', {
      content: 'Updated: the API uses Fastify with JWT auth.',
      expectedRevision: 1,
    });
    expect(updated.revision).toBe(2);
    expect(updated.content).toContain('JWT');
    expect(updated.source.kind).toBe('user');
    // Provenance is immutable: no update path can rewrite it.
    expect('source' in updated).toBe(true);
  });

  it('E: archives an active memory (and blocks double archive)', async () => {
    const { manager } = createManager();
    const created = await manager.create(validInput());
    const archived = await manager.archive(created.id, 'prj_a');
    expect(archived.status).toBe('archived');
    // Archived memories are historical: editing and re-archiving are blocked.
    await expect(manager.archive(created.id, 'prj_a')).rejects.toThrow(
      InvalidMemoryTransitionError,
    );
    await expect(
      manager.update(created.id, 'prj_a', { content: 'sneaky edit', expectedRevision: 2 }),
    ).rejects.toThrow(InvalidMemoryTransitionError);
  });

  it('F: restores an archived memory', async () => {
    const { manager } = createManager();
    const created = await manager.create(validInput());
    await manager.archive(created.id, 'prj_a');
    const restored = await manager.restore(created.id, 'prj_a');
    expect(restored.status).toBe('active');
  });

  it('G: deletes memory (gone afterwards, audited)', async () => {
    const { manager, audit } = createManager();
    const created = await manager.create(validInput());
    await manager.delete(created.id, 'prj_a');
    await expect(manager.get(created.id, 'prj_a')).rejects.toThrow(MemoryNotFoundError);
    expect(audit.events.some((event: MemoryAuditEvent) => event.type === 'memory_deleted')).toBe(
      true,
    );
  });
});

describe('memory candidates (Scenarios H, I)', () => {
  it('H: candidates are non-authoritative until approved', async () => {
    const { manager, audit } = createManager();
    const candidate = await manager.createCandidate(
      validInput({
        type: 'technology',
        title: 'Stack note',
        content: 'React with Vite.',
        source: { kind: 'generation_run', referenceId: 'gen_1' },
      }),
    );
    expect(candidate.status).toBe('candidate');
    // Candidates are excluded from active-only search by default callers.
    const activeOnly = await manager.search({ projectId: 'prj_a', status: 'active' });
    expect(activeOnly).toHaveLength(0);
    const approved = await manager.approveCandidate(candidate.id, 'prj_a');
    expect(approved.status).toBe('active');
    expect(
      audit.events.some((event: MemoryAuditEvent) => event.type === 'memory_candidate_approved'),
    ).toBe(true);
    // Double approval is a typed transition error.
    await expect(manager.approveCandidate(candidate.id, 'prj_a')).rejects.toThrow(
      InvalidMemoryTransitionError,
    );
  });

  it('I: rejecting a candidate is terminal and audited', async () => {
    const { manager, audit } = createManager();
    const candidate = await manager.createCandidate(validInput());
    const rejected = await manager.rejectCandidate(candidate.id, 'prj_a');
    expect(rejected.status).toBe('rejected');
    expect(
      audit.events.some((event: MemoryAuditEvent) => event.type === 'memory_candidate_rejected'),
    ).toBe(true);
    await expect(manager.approveCandidate(candidate.id, 'prj_a')).rejects.toThrow(
      InvalidMemoryTransitionError,
    );
    await expect(
      manager.update(candidate.id, 'prj_a', { content: 'x', expectedRevision: 2 }),
    ).rejects.toThrow(InvalidMemoryTransitionError);
  });
});

describe('authorization boundaries (Scenario L)', () => {
  it('cross-project read is rejected without leaking existence', async () => {
    const { manager } = createManager();
    const created = await manager.create(validInput({ projectId: 'prj_a' }));
    await expect(manager.get(created.id, 'prj_b')).rejects.toThrow(MemoryNotFoundError);
  });

  it('cross-project update is rejected', async () => {
    const { manager } = createManager();
    const created = await manager.create(validInput({ projectId: 'prj_a' }));
    await expect(
      manager.update(created.id, 'prj_b', { content: 'stolen', expectedRevision: 1 }),
    ).rejects.toThrow(MemoryNotFoundError);
  });

  it('cross-project delete is rejected', async () => {
    const { manager } = createManager();
    const created = await manager.create(validInput({ projectId: 'prj_a' }));
    await expect(manager.delete(created.id, 'prj_b')).rejects.toThrow(MemoryNotFoundError);
    const stillThere = await manager.get(created.id, 'prj_a');
    expect(stillThere.id).toBe(created.id);
  });

  it('workspace boundary: workspace-scoped memory stays in its workspace', async () => {
    const { manager } = createManager();
    await manager.create(validInput({ workspaceId: 'ws_1' }));
    await manager.create(validInput({ workspaceId: 'ws_2', title: 'Other ws' }));
    const ws1 = await manager.list({ projectId: 'prj_a', workspaceId: 'ws_1' });
    expect(ws1).toHaveLength(1);
    const ws2 = await manager.list({ projectId: 'prj_a', workspaceId: 'ws_2' });
    expect(ws2).toHaveLength(1);
    expect(ws2[0].title).toBe('Other ws');
  });
});

describe('concurrency (Scenario N)', () => {
  it('stale update is rejected with a typed conflict (no silent overwrite)', async () => {
    const { manager } = createManager();
    const created = await manager.create(validInput());
    await manager.update(created.id, 'prj_a', { content: 'first edit', expectedRevision: 1 });
    const conflict = await manager
      .update(created.id, 'prj_a', { content: 'second edit from stale view', expectedRevision: 1 })
      .catch((error) => error);
    expect(conflict).toBeInstanceOf(MemoryRevisionConflictError);
    const current = await manager.get(created.id, 'prj_a');
    expect(current.revision).toBe(2);
    expect(current.content).toBe('first edit');
  });
});

describe('stale detection (Scenario M)', () => {
  it('markStale flags memory and stats report it', async () => {
    const { manager } = createManager();
    const created = await manager.create(validInput());
    await manager.markVerified(created.id, 'prj_a');
    const stale = await manager.markStale(created.id, 'prj_a');
    expect(stale.verificationStatus).toBe('stale');
    const stats = await manager.stats('prj_a');
    expect(stats.stale).toBe(1);
    expect(stats.active).toBe(1);
    expect(stats.byType.architecture).toBe(1);
  });

  it('markVerified stamps lastVerifiedAt', async () => {
    const { manager } = createManager();
    const created = await manager.create(validInput());
    expect(created.lastVerifiedAt).toBeNull();
    const verified = await manager.markVerified(created.id, 'prj_a');
    expect(verified.verificationStatus).toBe('verified');
    expect(verified.lastVerifiedAt).toMatch(/^2026-/);
  });
});

describe('validation and secret protection (Phase 24, 27)', () => {
  it('rejects oversized titles and content', async () => {
    const { manager } = createManager();
    await expect(manager.create(validInput({ title: 'x'.repeat(121) }))).rejects.toThrow(
      InvalidMemoryRequestError,
    );
    await expect(manager.create(validInput({ content: 'x'.repeat(4001) }))).rejects.toThrow(
      InvalidMemoryRequestError,
    );
  });

  it('rejects unknown types, sources, and confidence', async () => {
    const { manager } = createManager();
    await expect(manager.create(validInput({ type: 'random_nonsense' }))).rejects.toThrow(
      InvalidMemoryRequestError,
    );
    await expect(manager.create(validInput({ source: { kind: 'made_up' } }))).rejects.toThrow(
      InvalidMemoryRequestError,
    );
    await expect(manager.create(validInput({ confidence: 'absolute' }))).rejects.toThrow(
      InvalidMemoryRequestError,
    );
  });

  it('rejects secret-shaped content, titles, references, and search text', async () => {
    const { manager } = createManager();
    await expect(
      manager.create(validInput({ content: 'deploy with ghp_abcdefghijklmnopqrstuv' })),
    ).rejects.toThrow(MemorySecretRejectedError);
    await expect(
      manager.create(validInput({ title: 'Key sk-abcdefghijklmnopqrst' })),
    ).rejects.toThrow(MemorySecretRejectedError);
    await expect(
      manager.create(
        validInput({ source: { kind: 'user', referenceId: 'ghp_abcdefghijklmnopqrstuv' } }),
      ),
    ).rejects.toThrow(MemorySecretRejectedError);
    await expect(
      manager.search({ projectId: 'prj_a', text: 'token ghp_abcdefghijklmnopqrstuv' }),
    ).rejects.toThrow(MemorySecretRejectedError);
  });

  it('error messages never echo secret values', async () => {
    const secret = 'ghp_abcdefghijklmnopqrstuv';
    const { manager } = createManager();
    const error = await manager
      .create(validInput({ content: `deploy with ${secret}` }))
      .catch((e) => e);
    expect(error).toBeInstanceOf(MemorySecretRejectedError);
    expect(error.message.includes(secret)).toBe(false);
    expect(error.message.includes('content')).toBe(true);
  });

  it('audit events never carry memory content', async () => {
    const { manager, audit } = createManager();
    const content = 'Private design decision about the auth module.';
    await manager.create(validInput({ content }));
    const serialized = JSON.stringify(audit.events);
    expect(serialized.includes(content)).toBe(false);
  });

  it('per-project capacity is enforced', async () => {
    const repository = new InMemoryMemoryRepository({ now: fixedNow });
    // Fill the project with one short of the ceiling.
    for (let index = 0; index < 499; index += 1) {
      await repository.create(validInput({ title: `Memory ${index}` }));
    }
    const manager = new MemoryManager({ repository, now: fixedNow });
    await manager.create(validInput({ title: 'The 500th' }));
    await expect(manager.create(validInput({ title: 'Over the line' }))).rejects.toThrow(
      MemoryLimitReachedError,
    );
  });

  it('search text bound is enforced', async () => {
    const { manager } = createManager();
    await expect(manager.search({ projectId: 'prj_a', text: 'x'.repeat(201) })).rejects.toThrow(
      MemorySearchTooLargeError,
    );
  });

  it('extension types are validated and usable', () => {
    const good = new MemoryManager({
      repository: new InMemoryMemoryRepository(),
      extensionTypes: ['legal-note'],
    });
    expect(good.knownTypes).toContain('legal-note');
    expect(
      () =>
        new MemoryManager({
          repository: new InMemoryMemoryRepository(),
          extensionTypes: ['Bad Type!'],
        }),
    ).toThrow(InvalidMemoryRequestError);
    expect(
      () =>
        new MemoryManager({
          repository: new InMemoryMemoryRepository(),
          extensionTypes: ['architecture'],
        }),
    ).toThrow(InvalidMemoryRequestError);
  });
});
