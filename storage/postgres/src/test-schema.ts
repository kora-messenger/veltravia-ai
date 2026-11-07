/**
 * Per-file test schemas.
 *
 * Every database test file used the same `public` schema, so files running in
 * parallel saw each other's rows - and a reset in one file deleted another
 * file's fixtures mid-test. Each file now gets its own schema, dropped and
 * recreated before it runs, and points its connections at it through
 * `search_path`.
 *
 * This is test scaffolding, not product behaviour: nothing here runs in the API.
 */

import pg from 'pg';

/** A schema name Postgres will accept, derived from a readable file label. */
export function testSchemaName(label: string): string {
  const cleaned = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return `test_${cleaned === '' ? 'suite' : cleaned}`;
}

/**
 * Drops and recreates this file's schema, then returns a URL bound to it.
 *
 * Returns null when no test database is configured, so callers can keep
 * skipping rather than failing.
 */
export async function prepareIsolatedTestSchema(
  baseUrl: string,
  label: string,
): Promise<string | null> {
  const url = baseUrl.trim();
  if (url === '') return null;
  const schema = testSchemaName(label);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.query(`CREATE SCHEMA "${schema}"`);
  } finally {
    await client.end().catch(() => undefined);
  }
  const scoped = new URL(url);
  scoped.searchParams.set('options', `-c search_path=${schema}`);
  return scoped.toString();
}
