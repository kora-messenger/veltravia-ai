import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../server.js';
import { resolveDeploymentConfig } from './config.js';
import { createDurableGatewayStores } from './durable-stores.js';
import { installGracefulShutdown } from './shutdown.js';
import { createLogger } from './logger.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function app(env: Record<string, string | undefined>, extra: Record<string, unknown> = {}) {
  return buildApp({ deployment: resolveDeploymentConfig({ env }), ...extra });
}

describe('health and readiness', () => {
  it('answers liveness without touching a dependency', async () => {
    const instance = await app({});
    const response = await instance.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', mode: 'development' });
    await instance.close();
  });

  it('reports ready with a named check per dependency', async () => {
    const instance = await app({});
    const response = await instance.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { status: string; checks: { name: string }[] };
    expect(body.status).toBe('ready');
    expect(body.checks.map((check) => check.name)).toContain('configuration');
    await instance.close();
  });

  it('answers 503 when durable storage cannot be written', async () => {
    const instance = await app(
      { VELTRAVIA_STORAGE_DRIVER: 'file', VELTRAVIA_DATA_DIR: '/var/data' },
      {
        verifyStorage: async () => {
          throw new Error('disk is read-only at /srv/secret-path');
        },
      },
    );
    const response = await instance.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(503);
    const body = response.json() as { status: string; checks: { name: string; detail?: string }[] };
    expect(body.status).toBe('not-ready');
    expect(body.checks.find((check) => check.name === 'storage')?.status).toBe('fail');
    // the failure text is ours, not the underlying error's
    expect(JSON.stringify(body)).not.toContain('/srv/secret-path');
    await instance.close();
  });

  it('fails readiness on a configuration that was not safe to start', async () => {
    const instance = await app({ NODE_ENV: 'staging' });
    const response = await instance.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(503);
    const body = response.json() as { checks: { name: string; status: string }[] };
    expect(body.checks.find((check) => check.name === 'configuration')?.status).toBe('fail');
    await instance.close();
  });

  it('keeps environment values and paths out of both answers', async () => {
    const instance = await app({
      VELTRAVIA_CREDENTIAL_KEY: 'super-secret-key-value',
      DATABASE_URL: 'postgresql://user:pw@db.internal:5432/veltravia',
      VELTRAVIA_DATA_DIR: '/srv/very-private-data',
    });
    for (const url of ['/health', '/ready']) {
      const text = (await instance.inject({ method: 'GET', url })).body;
      expect(text).not.toContain('super-secret-key-value');
      expect(text).not.toContain('db.internal');
      expect(text).not.toContain('/srv/very-private-data');
    }
    await instance.close();
  });
});

describe('cross-origin access', () => {
  it('answers a named origin and reflects it back', async () => {
    const instance = await app({ VELTRAVIA_CORS_ORIGINS: 'https://app.example.test' });
    const response = await instance.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://app.example.test' },
    });
    expect(response.headers['access-control-allow-origin']).toBe('https://app.example.test');
    expect(response.headers.vary).toBe('Origin');
    await instance.close();
  });

  it('refuses an unlisted origin outright', async () => {
    const instance = await app({ VELTRAVIA_CORS_ORIGINS: 'https://app.example.test' });
    const response = await instance.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://attacker.test' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    await instance.close();
  });

  it('never reflects a wildcard back as if it were allowed', async () => {
    const instance = await app({ VELTRAVIA_CORS_ORIGINS: 'https://app.example.test' });
    const response = await instance.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: '*' },
    });
    expect(response.statusCode).toBe(403);
    await instance.close();
  });

  it('answers a preflight for an allowed origin with the granted methods', async () => {
    const instance = await app({ VELTRAVIA_CORS_ORIGINS: 'https://app.example.test' });
    const response = await instance.inject({
      method: 'OPTIONS',
      url: '/api/projects',
      headers: {
        origin: 'https://app.example.test',
        'access-control-request-method': 'POST',
      },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-methods']).toContain('POST');
    await instance.close();
  });

  it('allows no cross-origin caller at all when none is configured', async () => {
    const instance = await app({});
    const response = await instance.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://anything.test' },
    });
    expect(response.statusCode).toBe(403);
    await instance.close();
  });
});

describe('responses and request handling', () => {
  it('marks API answers as uncacheable and non-sniffable', async () => {
    const instance = await app({});
    const response = await instance.inject({ method: 'GET', url: '/api/ai/providers' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    await instance.close();
  });

  it('hides an unexpected failure behind a request id', async () => {
    const instance = await app({});
    instance.get('/__boom', async () => {
      throw new Error('connection string postgresql://user:pw@db.internal');
    });
    const response = await instance.inject({ method: 'GET', url: '/__boom' });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('db.internal');
    expect(response.body).not.toContain('postgresql');
    expect(response.body).not.toMatch(/\bat .*\(.*:\d+:\d+\)/);
    expect((response.json() as { requestId?: string }).requestId).toBeDefined();
    await instance.close();
  });

  it('keeps a client error message, which is written for a person', async () => {
    const instance = await app({});
    const response = await instance.inject({
      method: 'POST',
      url: '/api/reasoning/runs',
      headers: { 'content-type': 'application/json' },
      payload: { nope: true },
    });
    expect(response.statusCode).toBe(400);
    await instance.close();
  });

  it('answers an unknown route with 404 and no stack', async () => {
    const instance = await app({});
    const response = await instance.inject({ method: 'GET', url: '/api/nothing-here' });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('stack');
    await instance.close();
  });

  it('refuses a body larger than the configured limit', async () => {
    const instance = await app({});
    const response = await instance.inject({
      method: 'POST',
      url: '/api/reasoning/runs',
      headers: { 'content-type': 'application/json' },
      payload: { task: 'x'.repeat(41 * 1024 * 1024) },
    });
    expect(response.statusCode).toBe(413);
    await instance.close();
  });

  it('ignores a forwarded address unless the deployment trusts a proxy', async () => {
    const direct = await app({});
    direct.get('/__ip', async (request) => ({ ip: request.ip }));
    const spoofed = await direct.inject({
      method: 'GET',
      url: '/__ip',
      headers: { 'x-forwarded-for': '203.0.113.9' },
    });
    expect((spoofed.json() as { ip: string }).ip).not.toBe('203.0.113.9');
    await direct.close();

    const behindProxy = await app({ VELTRAVIA_TRUST_PROXY: 'true' });
    behindProxy.get('/__ip', async (request) => ({ ip: request.ip }));
    const trusted = await behindProxy.inject({
      method: 'GET',
      url: '/__ip',
      headers: { 'x-forwarded-for': '203.0.113.9' },
    });
    expect((trusted.json() as { ip: string }).ip).toBe('203.0.113.9');
    await behindProxy.close();
  });

  it('leaves a streamed body untouched on its way out', async () => {
    const instance = await app({});
    const chunks = ['data: {"phase":"reading"}\n\n', 'data: {"phase":"done"}\n\n'];
    instance.get('/__stream', async (_request, reply) => {
      reply.header('content-type', 'text/event-stream');
      return reply.send(chunks.join(''));
    });
    const response = await instance.inject({ method: 'GET', url: '/__stream' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(chunks.join(''));
    expect(response.headers['content-type']).toContain('text/event-stream');
    await instance.close();
  });
});

describe('durable gateway stores', () => {
  it('survives a new store instance, so a restart keeps credentials', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'veltravia-gateway-'));
    dirs.push(dir);
    const first = createDurableGatewayStores(dir);
    await first.usage.record({
      id: 'u1',
      ownerRef: 'owner-1',
      providerId: 'openai',
      modelId: 'gpt-4o-mini',
    } as never);

    const second = createDurableGatewayStores(dir);
    const listed = await second.usage.listByOwner('owner-1');
    expect(listed).toHaveLength(1);
    expect(await second.usage.listByOwner('someone-else')).toHaveLength(0);
  });

  it('reports storage as unusable instead of pretending', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'veltravia-gateway-'));
    dirs.push(dir);
    // a directory where the file must go: writing the collection cannot work
    await writeFile(join(dir, 'usage-records.json'), '', 'utf8');
    const stores = createDurableGatewayStores(dir);
    await expect(stores.verify()).rejects.toThrow();
  });
});

describe('structured logs', () => {
  function capture() {
    const lines: string[] = [];
    const logger = createLogger(resolveDeploymentConfig({ env: { NODE_ENV: 'development' } }), {
      write: (line: string) => lines.push(line),
    });
    return { logger, lines };
  }

  it('writes one structured line per event', () => {
    const { logger, lines } = capture();
    logger.info({ route: '/health' }, 'healthy');
    const line = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(line.msg).toBe('healthy');
    expect(line.service).toBe('veltravia-api');
    expect(line.level).toBe(30);
  });

  it('replaces a credential with a marker at any depth', () => {
    const { logger, lines } = capture();
    logger.info(
      {
        provider: { apiKey: 'sk-live-super-secret', modelId: 'gpt-4o-mini' },
        body: { password: 'hunter2' },
        token: 'bearer-abc',
      },
      'connected',
    );
    const text = lines[0] ?? '';
    expect(text).not.toContain('sk-live-super-secret');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('bearer-abc');
    expect(text).toContain('[redacted]');
    // the harmless field is still there, so the line stays useful
    expect(text).toContain('gpt-4o-mini');
  });

  it('redacts an authorization header', () => {
    const { logger, lines } = capture();
    logger.info({ req: { headers: { authorization: 'Bearer abc123' } } }, 'request');
    expect(lines[0] ?? '').not.toContain('abc123');
  });
});

describe('graceful shutdown', () => {
  it('closes the server and exits zero on SIGTERM', async () => {
    const instance = await app({});
    const messages: string[] = [];
    const codes: number[] = [];
    let closed = false;
    instance.addHook('onClose', async () => {
      closed = true;
    });
    const stop = installGracefulShutdown(instance, {
      timeoutMs: 1000,
      log: (message) => messages.push(message),
      exit: (code) => codes.push(code),
    });
    await stop();
    expect(closed).toBe(true);
    expect(codes).toEqual([0]);
    expect(messages.join(' ')).toContain('closed cleanly');
  });

  it('exits non-zero when the grace period runs out', async () => {
    const instance = await app({});
    // a close that never finishes, standing in for a stuck request
    instance.close = () => new Promise(() => undefined);
    const codes: number[] = [];
    const stop = installGracefulShutdown(instance, {
      timeoutMs: 20,
      log: () => undefined,
      exit: (code) => codes.push(code),
    });
    await stop();
    expect(codes).toEqual([1]);
  });
});
