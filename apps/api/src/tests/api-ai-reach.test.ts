import { describe, expect, it } from 'vitest';
import { listReasoningProfiles } from '@veltravia/reasoning-core';
import { buildApp } from '../server.js';
import {
  READ_ONLY_AUDIO_TOOLS,
  READ_ONLY_DOCUMENT_TOOLS,
  READ_ONLY_IMAGE_TOOLS,
  READ_ONLY_VIDEO_TOOLS,
} from '../tools.js';

/**
 * What the AI can actually reach. The pages for documents, images, video,
 * audio, connected apps and integrations are only useful to the assistant if
 * its tool manager holds their tools AND the active profile may name them, so
 * this reads the live /api/reasoning surface rather than the source lists.
 */
interface ToolRow {
  readonly id: string;
  readonly available: boolean;
}

async function surface() {
  const app = buildApp({});
  const body = (await app.inject({ method: 'GET', url: '/api/reasoning' })).json();
  const tools = body.tools as ToolRow[];
  return { app, tools, byId: new Map(tools.map((tool) => [tool.id, tool])) };
}

function profilePrefixes(id: string): readonly string[] {
  const found = listReasoningProfiles().find((profile) => profile.id === id);
  if (found === undefined) throw new Error(`unknown profile ${id}`);
  return found.toolPrefixes;
}

describe('what the assistant can reach', () => {
  it('holds the read-only tools of every media and document family', async () => {
    const { app, byId } = await surface();
    const expected = [
      ...READ_ONLY_DOCUMENT_TOOLS,
      ...READ_ONLY_IMAGE_TOOLS,
      ...READ_ONLY_AUDIO_TOOLS,
      ...READ_ONLY_VIDEO_TOOLS,
    ];
    expect(expected.length).toBeGreaterThan(20);
    for (const id of expected) {
      expect(byId.get(id), `${id} is missing from the assistant's tools`).toBeDefined();
      expect(byId.get(id)?.available, `${id} is not available`).toBe(true);
    }
    await app.close();
  });

  it('keeps tools that start work, create artifacts or delete out of its hands', async () => {
    const { app, byId } = await surface();
    for (const id of [
      'document.process',
      'document.memory_candidates',
      'image.analyze',
      'image.artifact',
      'audio.transcribe',
      'audio.translate',
      'video.process',
      'video.artifact',
      'file.delete',
      'mock.purge',
    ]) {
      const row = byId.get(id);
      // Registered so an operator can enable it, but never available by default.
      expect(row?.available ?? false, `${id} must not be available by default`).toBe(false);
    }
    await app.close();
  });

  it('lets the general agent name every family it can read', async () => {
    const { app, tools } = await surface();
    const prefixes = profilePrefixes('agent');
    for (const family of ['document.', 'image.', 'audio.', 'video.', 'file.', 'intelligence.']) {
      const reachable = tools.filter(
        (tool) =>
          tool.available &&
          tool.id.startsWith(family) &&
          prefixes.some((p) => tool.id.startsWith(p)),
      );
      expect(reachable.length, `agent cannot reach any ${family} tool`).toBeGreaterThan(0);
    }
    await app.close();
  });

  it('gives the document analyst real document tools (it used to reach none)', async () => {
    const { app, tools } = await surface();
    const prefixes = profilePrefixes('document');
    const reachable = tools.filter(
      (tool) => tool.available && prefixes.some((p) => tool.id.startsWith(p)),
    );
    expect(reachable.map((tool) => tool.id)).toEqual(
      expect.arrayContaining(['document.ask', 'document.search', 'document.summarize']),
    );
    await app.close();
  });

  it('has no profile prefix that matches no tool at all', async () => {
    // The old profiles named `files.` and `documents.`; no tool starts with
    // either, so those profiles silently reached nothing.
    const { app, tools } = await surface();
    for (const profile of listReasoningProfiles()) {
      for (const prefix of profile.toolPrefixes) {
        if (prefix === 'github.' || prefix === 'connections.' || prefix === 'project.') continue;
        if (prefix === 'sandbox.' || prefix === 'integrations.') continue;
        expect(
          tools.some((tool) => tool.id.startsWith(prefix)),
          `profile ${profile.id} names "${prefix}" but no tool starts with it`,
        ).toBe(true);
      }
    }
    await app.close();
  });
});

describe('connected apps', () => {
  it('registers the connector tools but keeps them unavailable until a connection exists', async () => {
    const { app, byId } = await surface();
    for (const id of [
      'storage.object.get',
      'storage.object.put',
      'storage.object.delete',
      'database.rows.select',
      'database.rows.insert',
      'database.tables.drop',
    ]) {
      expect(byId.get(id), `${id} should be registered`).toBeDefined();
      expect(byId.get(id)?.available, `${id} must fail closed without a connection`).toBe(false);
    }
    await app.close();
  });

  it('lets the connected-apps profile name the connector tools once a connection exists', () => {
    const prefixes = profilePrefixes('connected-apps');
    for (const id of ['storage.object.get', 'database.rows.select', 'database.tables.drop']) {
      expect(
        prefixes.some((p) => id.startsWith(p)),
        `${id} is unreachable by name`,
      ).toBe(true);
    }
  });
});
