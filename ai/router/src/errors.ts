/**
 * Router errors.
 *
 * Every code names a decision the router refused to fake: a task no model can
 * do, a model that does not meet the requirements, a preference the caller may
 * not use, or a project that is not theirs. Messages are written for a person,
 * carry no provider configuration and never contain a credential.
 */

export const ROUTER_ERROR_CODES = [
  'ROUTER_INVALID_REQUEST',
  'ROUTER_UNKNOWN_CATEGORY',
  'ROUTER_NO_PROVIDER',
  'ROUTER_CAPABILITY_UNSUPPORTED',
  'ROUTER_MODEL_UNAVAILABLE',
  'ROUTER_MODEL_NOT_COMPATIBLE',
  'ROUTER_CONTEXT_TOO_SMALL',
  'ROUTER_PREFERENCE_UNUSABLE',
  'ROUTER_FALLBACK_REFUSED',
  'ROUTER_DECISION_NOT_FOUND',
  'ROUTER_LIMIT_EXCEEDED',
] as const;

export type RouterErrorCode = (typeof ROUTER_ERROR_CODES)[number];

export class RouterError extends Error {
  readonly code: RouterErrorCode;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;

  constructor(
    code: RouterErrorCode,
    message: string,
    details: Readonly<Record<string, string | number | boolean | null>> = {},
  ) {
    super(message);
    this.name = 'RouterError';
    this.code = code;
    this.details = details;
  }
}

export function isRouterError(value: unknown): value is RouterError {
  return value instanceof RouterError;
}

/** HTTP status for a router code, so a route never leaks a bare 500. */
export function routerHttpStatus(code: RouterErrorCode): number {
  switch (code) {
    case 'ROUTER_INVALID_REQUEST':
    case 'ROUTER_UNKNOWN_CATEGORY':
    case 'ROUTER_MODEL_NOT_COMPATIBLE':
    case 'ROUTER_CONTEXT_TOO_SMALL':
    case 'ROUTER_PREFERENCE_UNUSABLE':
      return 400;
    case 'ROUTER_NO_PROVIDER':
    case 'ROUTER_CAPABILITY_UNSUPPORTED':
    case 'ROUTER_MODEL_UNAVAILABLE':
    case 'ROUTER_FALLBACK_REFUSED':
      return 409;
    case 'ROUTER_DECISION_NOT_FOUND':
      return 404;
    case 'ROUTER_LIMIT_EXCEEDED':
      return 413;
    default:
      return 500;
  }
}
