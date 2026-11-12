/**
 * Usage history routes (Step 58).
 *
 * Five reads, all of them the owner's own: the overview, one filtered page of
 * history, a breakdown for a chosen dimension, a CSV of the same filtered set,
 * and the capability card that says what a category means.
 *
 * Two rules are enforced here rather than in the browser:
 *
 *  - the caller comes from the request context, so another owner's project id
 *    narrows the answer to nothing instead of widening access;
 *  - the export is produced from the same filtered read as the screen, so a CSV
 *    cannot contain a row the page would have refused to show.
 *
 * Nothing here charges, refunds or edits. Every number is read from the wallet,
 * the charge tables or the usage records.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { resolveCallerOwnerRef } from '../project-access.js';
import {
  UsageHistoryError,
  isUsageHistoryCategory,
  type UsageBreakdownDimension,
  type UsageEventStatus,
  type UsageHistoryCategory,
  type UsageHistoryFilters,
  type UsageHistoryService,
} from '../usage-history.js';

export interface UsageHistoryRouteDeps {
  readonly history: UsageHistoryService;
}

/** The dimensions a caller may ask for; an unknown one is a 400, not a default. */
const DIMENSIONS: readonly UsageBreakdownDimension[] = [
  'category',
  'project',
  'model',
  'provider',
  'day',
  'month',
  'activity',
];

const STATUSES: readonly UsageEventStatus[] = [
  'reserved',
  'committed',
  'released',
  'refunded',
  'exempt',
  'measured',
];

function str(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  return undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function list(value: unknown): string[] {
  const raw = str(value);
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/** Query string → the service's filter shape, refusing anything invented. */
function filtersOf(request: FastifyRequest): UsageHistoryFilters {
  const query = (request.query ?? {}) as Record<string, unknown>;
  const categories = list(query['category']);
  const unknownCategory = categories.find((entry) => !isUsageHistoryCategory(entry));
  if (unknownCategory !== undefined) {
    throw new UsageHistoryError(
      'INVALID_FILTER',
      `"${unknownCategory}" is not a usage category.`,
      400,
    );
  }
  const statuses = list(query['status']);
  const unknownStatus = statuses.find((entry) => !(STATUSES as readonly string[]).includes(entry));
  if (unknownStatus !== undefined) {
    throw new UsageHistoryError(
      'INVALID_FILTER',
      `"${unknownStatus}" is not a charge status.`,
      400,
    );
  }
  const workspaceId = str(query['workspaceId']);
  return {
    ...(str(query['from']) === undefined ? {} : { from: str(query['from']) }),
    ...(str(query['to']) === undefined ? {} : { to: str(query['to']) }),
    ...(categories.length === 0 ? {} : { categories: categories as UsageHistoryCategory[] }),
    ...(str(query['projectId']) === undefined ? {} : { projectId: str(query['projectId']) }),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(statuses.length === 0 ? {} : { status: statuses as UsageEventStatus[] }),
    ...(str(query['modelId']) === undefined ? {} : { modelId: str(query['modelId']) }),
    ...(str(query['providerId']) === undefined ? {} : { providerId: str(query['providerId']) }),
    ...(str(query['q']) === undefined ? {} : { query: str(query['q']) }),
  };
}

function fail(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof UsageHistoryError) {
    return reply.status(error.status).send({ error: { code: error.code, message: error.message } });
  }
  return reply.status(503).send({
    error: {
      code: 'USAGE_HISTORY_UNAVAILABLE',
      message: 'The usage history could not be read just now. Nothing was charged or changed.',
    },
  });
}

const filterSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    from: { type: 'string', maxLength: 10 },
    to: { type: 'string', maxLength: 10 },
    category: { type: 'string', maxLength: 200 },
    status: { type: 'string', maxLength: 200 },
    projectId: { type: 'string', maxLength: 128 },
    workspaceId: { type: 'string', maxLength: 128 },
    modelId: { type: 'string', maxLength: 160 },
    providerId: { type: 'string', maxLength: 160 },
    q: { type: 'string', maxLength: 120 },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    cursor: { type: 'string', maxLength: 300 },
  },
} as const;

export function registerUsageHistoryRoutes(
  app: FastifyInstance,
  deps: UsageHistoryRouteDeps,
): void {
  const { history } = deps;

  /** What the page is allowed to claim about each category. */
  app.get('/api/usage-history/capabilities', async () => history.capabilities());

  /**
   * The numbers above the table: the wallet's own balance (never recomputed),
   * this month's use, the selected range, and the infrastructure strip that says
   * which measurements exist at all.
   */
  app.get('/api/usage-history/overview', async (request, reply) => {
    try {
      const query = (request.query ?? {}) as Record<string, unknown>;
      const workspaceId = str(query['workspaceId']);
      return reply.send(
        await history.overview({
          ownerRef: resolveCallerOwnerRef(request),
          ...(workspaceId === undefined ? {} : { workspaceId }),
        }),
      );
    } catch (error) {
      return fail(reply, error);
    }
  });

  /** One filtered page. Server-side filters, a cursor, and an honest total. */
  app.get(
    '/api/usage-history',
    { schema: { querystring: filterSchema } },
    async (request, reply) => {
      try {
        const query = (request.query ?? {}) as Record<string, unknown>;
        const workspaceId = str(query['workspaceId']);
        const limit = num(query['limit']);
        const cursor = str(query['cursor']);
        return reply.send(
          await history.history(
            {
              ownerRef: resolveCallerOwnerRef(request),
              ...(workspaceId === undefined ? {} : { workspaceId }),
            },
            {
              ...filtersOf(request),
              ...(limit === undefined ? {} : { limit }),
              ...(cursor === undefined ? {} : { cursor }),
            },
          ),
        );
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  /** Usage by category, project, model, provider, day, month or activity. */
  app.get(
    '/api/usage-history/breakdown',
    { schema: { querystring: filterSchema } },
    async (request, reply) => {
      try {
        const query = (request.query ?? {}) as Record<string, unknown>;
        const dimension = str(query['dimension']);
        if (dimension !== undefined && !(DIMENSIONS as readonly string[]).includes(dimension)) {
          return reply.status(400).send({
            error: {
              code: 'INVALID_DIMENSION',
              message: `"${dimension}" is not a breakdown this dashboard offers.`,
            },
          });
        }
        const workspaceId = str(query['workspaceId']);
        return reply.send(
          await history.breakdown(
            {
              ownerRef: resolveCallerOwnerRef(request),
              ...(workspaceId === undefined ? {} : { workspaceId }),
            },
            {
              ...filtersOf(request),
              ...(dimension === undefined
                ? {}
                : { dimension: dimension as UsageBreakdownDimension }),
            },
          ),
        );
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  /**
   * The same filtered set as a CSV download.
   *
   * A truncated export says so in a header as well as in the file, because a
   * spreadsheet cannot carry a caveat and a person reading one row will not know
   * the last 4,000 records were left out.
   */
  app.get(
    '/api/usage-history/export.csv',
    { schema: { querystring: filterSchema } },
    async (request, reply) => {
      try {
        const query = (request.query ?? {}) as Record<string, unknown>;
        const workspaceId = str(query['workspaceId']);
        const result = await history.exportCsv(
          {
            ownerRef: resolveCallerOwnerRef(request),
            ...(workspaceId === undefined ? {} : { workspaceId }),
          },
          filtersOf(request),
        );
        const filename = `veltravia-usage-${result.range.from}-to-${result.range.to}.csv`;
        return reply
          .status(200)
          .header('content-type', 'text/csv; charset=utf-8')
          .header('content-disposition', `attachment; filename="${filename}"`)
          .header('cache-control', 'no-store')
          .header('x-content-type-options', 'nosniff')
          .header('x-veltravia-export-rows', String(result.rows))
          .header('x-veltravia-export-truncated', result.truncated ? 'true' : 'false')
          .header('x-veltravia-export-window', `${result.range.from} to ${result.range.to}`)
          .send(result.csv);
      } catch (error) {
        return fail(reply, error);
      }
    },
  );
}
