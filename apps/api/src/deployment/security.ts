import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DeploymentConfig } from './config.js';

/**
 * The network-facing rules of the API: who may call it, how large a request may
 * be, how long it may take, and what an error is allowed to say.
 *
 * Two rules drive all of it. A credentialed cross-origin call is answered only
 * for an origin named in configuration, so no wildcard can hand a browser's
 * cookie or token to a stranger. And an unexpected failure answers with a plain
 * message and a request id; the stack, the SQL, the path and the secret stay on
 * the server, in the log.
 */

/** Headers every response carries, whatever the route returns. */
const BASELINE_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

/** Paths whose bodies must never be cached by a browser or a proxy. */
const NEVER_CACHED = [
  '/api/auth',
  '/api/ai/providers',
  '/api/agent-profile',
  '/api/reasoning',
  '/api/ai',
  '/ready',
];

function shouldNotCache(url: string): boolean {
  const path = url.split('?')[0] ?? url;
  return NEVER_CACHED.some((prefix) => path.startsWith(prefix));
}

export interface RegisterSecurityOptions {
  readonly config: DeploymentConfig;
  /** Per-request id, so a client can quote it when reporting a failure. */
  readonly logger?: { error: (fields: object, message: string) => void };
}

export function registerSecurity(app: FastifyInstance, options: RegisterSecurityOptions): void {
  const { config } = options;
  const allowed = new Set(config.corsOrigins);

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    for (const [name, value] of Object.entries(BASELINE_HEADERS)) reply.header(name, value);
    if (shouldNotCache(request.url)) reply.header('cache-control', 'no-store');

    const origin = request.headers.origin;
    if (origin === undefined) return;

    // Exact match only, and never a reflected wildcard: `*` in the request is
    // treated like any other unlisted origin.
    if (!allowed.has(origin)) {
      request.log.warn({ origin }, 'cross-origin request refused');
      return reply.code(403).send({ code: 'CORS_ORIGIN_REFUSED', message: 'Origin not allowed.' });
    }

    reply.header('access-control-allow-origin', origin);
    reply.header('vary', 'Origin');
    reply.header('access-control-allow-credentials', 'true');

    if (request.method === 'OPTIONS') {
      const requested = request.headers['access-control-request-method'];
      reply
        .header('access-control-allow-methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS')
        .header(
          'access-control-allow-headers',
          request.headers['access-control-request-headers'] ??
            'content-type, x-veltravia-owner-ref',
        )
        .header('access-control-max-age', '600');
      return reply.code(requested === undefined ? 400 : 204).send();
    }
    return undefined;
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    // Fastify's own error shapes are JSON already; nothing to rewrite here.
    if (config.requiresHttps && reply.statusCode < 400) {
      reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    }
    return payload;
  });

  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const status = typeof error.statusCode === 'number' ? error.statusCode : 500;
    const code = typeof error.code === 'string' ? error.code : 'INTERNAL_ERROR';

    if (status >= 500) {
      // Full detail to the log, nothing but a request id to the caller.
      (options.logger?.error ?? (() => undefined))(
        {
          err: { name: error.name, message: error.message, stack: error.stack },
          requestId: request.id,
          method: request.method,
          url: request.url,
        },
        'request failed',
      );
      void reply.code(500).send({
        code: 'INTERNAL_ERROR',
        message: 'The server could not finish that request.',
        requestId: request.id,
      });
      return;
    }

    // A client error is the caller's to fix, so it keeps its own message: these
    // are written for people and contain no internals.
    void reply.code(status).send({ code, message: error.message });
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.code(404).send({
      code: 'ROUTE_NOT_FOUND',
      message: `No route for ${request.method} ${request.url.split('?')[0] ?? ''}`,
    });
  });
}

/** The options Fastify itself needs, resolved from the deployment config. */
export function fastifyLimits(config: DeploymentConfig): {
  bodyLimit: number;
  connectionTimeout: number;
  requestTimeout: number;
  trustProxy: boolean;
} {
  return {
    bodyLimit: config.bodyLimitBytes,
    connectionTimeout: config.connectionTimeoutMs,
    requestTimeout: config.requestTimeoutMs,
    // Never believe forwarded headers unless the deployment says it sits behind
    // a proxy it controls: an untrusted X-Forwarded-For is an identity spoof.
    trustProxy: config.trustProxy,
  };
}
