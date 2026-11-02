import { pino } from 'pino';
import type { DeploymentConfig } from './config.js';

/**
 * Operational logging with the secrets taken out before the line is written.
 *
 * Pino's `redact` removes the named paths from the object that is serialised, so
 * a key cannot reach a log sink even when an unrelated error object happens to
 * carry it. The list is deliberately broad: every name a credential could arrive
 * under in this codebase, plus the headers a browser sends.
 */
const REDACT_PATHS = [
  // Root-level names, for the common case of a bare field in a log call.
  'token',
  'apiKey',
  'password',
  'secret',
  'credential',
  'credentialRef',
  'plaintext',
  'privateKey',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-veltravia-credential"]',
  'res.headers["set-cookie"]',
  '*.apiKey',
  '*.api_key',
  '*.password',
  '*.secret',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.credential',
  '*.credentialRef',
  '*.plaintext',
  '*.privateKey',
  '*.encrypted',
  'headers.authorization',
  'body.password',
  'body.token',
  'body.apiKey',
];

export type Logger = ReturnType<typeof createLogger>;

/** Anything pino can write a serialised line to. Tests pass a collector. */
export interface LogSink {
  write(line: string): void;
}

export function createLogger(config: DeploymentConfig, sink?: LogSink) {
  const level = process.env.VELTRAVIA_LOG_LEVEL ?? (config.mode === 'test' ? 'silent' : 'info');
  return pino(
    {
      // Structured JSON everywhere; a platform's log drain can parse it and a
      // local terminal can still read it.
      level,
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
      base: { service: 'veltravia-api', mode: config.mode },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    sink,
  );
}
