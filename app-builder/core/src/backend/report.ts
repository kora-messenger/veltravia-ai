import {
  extractEnvironment,
  extractFunctions,
  extractManifest,
  extractModels,
  extractRoutes,
  type BackendFileText,
} from './extract.js';
import { classifyBackendStructure } from './structure.js';
import type {
  BackendAuthReport,
  BackendDatabaseReport,
  BackendManifest,
  BackendRecentChange,
  BackendReport,
  BackendRoute,
} from './types.js';

/**
 * Assembles a backend report from files that were already read.
 *
 * The report is a DESCRIPTION of what the project's files say, built from three
 * inputs: the file tree, the bounded text of backend-shaped files, and the
 * recent change log. It cannot connect to a database, cannot execute code and
 * cannot see a credential value - environment variables are reduced to names
 * before they get here.
 */

export interface BackendSnapshotFile {
  readonly path: string;
  readonly size: number;
  /** Bounded text. Files over the cap arrive truncated, never silently complete. */
  readonly content: string;
}

export interface BackendSnapshot {
  readonly files: readonly BackendSnapshotFile[];
  readonly framework: string | null;
  readonly language: string | null;
  readonly runtime: string | null;
  readonly recentChanges?: readonly BackendRecentChange[];
  readonly skippedFiles?: number;
  readonly truncated?: boolean;
}

const MAX_REPORTED_ROUTES = 250;
const MAX_REPORTED_MODELS = 80;
const MAX_REPORTED_FUNCTIONS = 80;
const MAX_REPORTED_ENV = 120;
const MAX_RECENT_CHANGES = 6;

/** Dependency name (lower-case) -> what it implies. Evidence, not a verdict. */
const AUTH_LIBRARIES: readonly { readonly match: RegExp; readonly provider: string }[] = [
  { match: /^next-auth$/, provider: 'NextAuth' },
  { match: /^@auth\//, provider: 'Auth.js' },
  { match: /^@clerk\//, provider: 'Clerk' },
  { match: /^@supabase\/auth-helpers/, provider: 'Supabase Auth' },
  { match: /^passport$/, provider: 'Passport' },
  { match: /^@fastify\/jwt$/, provider: 'JSON Web Tokens (@fastify/jwt)' },
  { match: /^jsonwebtoken$/, provider: 'JSON Web Tokens (jsonwebtoken)' },
  { match: /^firebase-admin$/, provider: 'Firebase Auth' },
  { match: /^auth0/, provider: 'Auth0' },
  { match: /^django-allauth$|^djangorestframework-simplejwt$/, provider: 'Django auth' },
  { match: /^flask-login$|^flask-jwt-extended$/, provider: 'Flask auth' },
  { match: /^bcrypt$|^bcryptjs$|^argon2$/, provider: 'Password hashing only' },
];

const DATABASE_LIBRARIES: readonly { readonly match: RegExp; readonly provider: string }[] = [
  { match: /^@prisma\/client$|^prisma$/, provider: 'Prisma' },
  { match: /^drizzle-orm$|^drizzle-kit$/, provider: 'Drizzle ORM' },
  { match: /^mongoose$|^mongodb$/, provider: 'MongoDB' },
  { match: /^pg$|^postgres$/, provider: 'PostgreSQL' },
  { match: /^mysql2?$/, provider: 'MySQL' },
  { match: /^better-sqlite3$|^sqlite3$/, provider: 'SQLite' },
  { match: /^@supabase\/supabase-js$/, provider: 'Supabase' },
  { match: /^firebase-admin$/, provider: 'Firestore' },
  { match: /^sequelize$|^typeorm$|^knex$/, provider: 'SQL via an ORM' },
  { match: /^psycopg2|^asyncpg$|^sqlalchemy$/i, provider: 'PostgreSQL (Python)' },
];

function summariseManifests(
  manifests: readonly BackendManifest[],
  table: readonly { readonly match: RegExp; readonly provider: string }[],
): { provider: string | null; evidence: string[] } {
  const evidence: string[] = [];
  let provider: string | null = null;
  for (const manifest of manifests) {
    for (const dependency of manifest.dependencies) {
      const lowered = dependency.toLowerCase();
      const hit = table.find((entry) => entry.match.test(lowered));
      if (hit !== undefined) {
        evidence.push(`${manifest.file}: ${dependency}`);
        provider = provider ?? hit.provider;
      }
    }
  }
  return { provider, evidence };
}

function authReport(
  routes: readonly BackendRoute[],
  manifests: readonly BackendManifest[],
  models: readonly string[],
): BackendAuthReport {
  const { provider, evidence } = summariseManifests(manifests, AUTH_LIBRARIES);
  const protectedRoutes = routes.filter((route) => route.auth === 'declared').length;
  const hashingOnly = provider === 'Password hashing only';
  const userModel =
    models.find((name) => /^(user|account|member|profile|person)$/i.test(name)) ?? null;

  return {
    status: provider === null ? 'absent' : 'declared',
    provider,
    evidence,
    loginMethods: [],
    sessionStrategy: 'not-inspected',
    protectedRoutes,
    userModel,
    note:
      provider === null
        ? 'No authentication library was named in a manifest. Routes that exist are not guarded by anything this report can see.'
        : hashingOnly
          ? 'A password-hashing library is present, which is not an authentication provider by itself. Login methods and sessions stay uninspected.'
          : `${provider} is named in a manifest. That is a declared dependency, not proof it is configured or that the app signs anyone in. Login methods, sessions and secrets are not inspected here.`,
  };
}

function databaseReport(
  manifests: readonly BackendManifest[],
  modelCount: number,
): BackendDatabaseReport {
  const { provider, evidence } = summariseManifests(manifests, DATABASE_LIBRARIES);
  return {
    status: provider === null ? 'absent' : 'declared',
    provider,
    connection: 'not-configured',
    evidence,
    models: modelCount,
    note:
      provider === null
        ? 'No database client is named in a manifest, and this release ships no database adapter. Nothing here is connected to a database.'
        : `${provider} is named in a manifest. No connection is opened by this release, no credentials are read, and the connection state is genuinely unknown.`,
  };
}

/** Analyses an already-read snapshot. Pure: no I/O, no execution, no clock. */
export function analyseBackend(snapshot: BackendSnapshot): BackendReport {
  const files: BackendFileText[] = snapshot.files.map((file) => ({
    path: file.path,
    content: file.content,
  }));

  const routes: BackendRoute[] = [];
  const models = [];
  const functions = [];
  const environment = [];
  const manifests: BackendManifest[] = [];

  for (const file of files) {
    routes.push(...extractRoutes(file));
    models.push(...extractModels(file));
    functions.push(...extractFunctions(file, snapshot.runtime));
    environment.push(...extractEnvironment(file));
    const manifest = extractManifest(file);
    if (manifest !== null) manifests.push(manifest);
  }

  // Declarations can repeat (a file read twice, a route mounted in two routers);
  // report each distinct declaration once.
  const routeKeys = new Set<string>();
  const uniqueRoutes = routes.filter((route) => {
    const key = `${route.method} ${route.path} ${route.file}:${route.line}`;
    if (routeKeys.has(key)) return false;
    routeKeys.add(key);
    return true;
  });
  uniqueRoutes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

  const modelNames = [...new Set(models.map((model) => model.name))];
  const structure = classifyBackendStructure({
    framework: snapshot.framework,
    language: snapshot.language,
    runtime: snapshot.runtime,
    files: snapshot.files.map((file) => ({ path: file.path, size: file.size })),
  });

  const seen = new Map<string, { name: string; sources: Set<string>; kind: 'code' | 'template' }>();
  for (const variable of environment) {
    const existing = seen.get(variable.name);
    if (existing === undefined) {
      seen.set(variable.name, {
        name: variable.name,
        sources: new Set(variable.sources),
        kind: variable.kind,
      });
      continue;
    }
    for (const source of variable.sources) existing.sources.add(source);
    if (variable.kind === 'code') existing.kind = 'code';
  }

  const warnings: string[] = [
    'Routes, models and functions are read from file text with pattern matching. A declaration this release does not recognise is missing, not absent.',
  ];
  if (snapshot.truncated === true) {
    warnings.push(
      'Some files were larger than the read limit, so their text was cut before analysis.',
    );
  }
  if ((snapshot.skippedFiles ?? 0) > 0) {
    warnings.push(
      `${snapshot.skippedFiles ?? 0} backend-shaped files were beyond the scan limit and were not read.`,
    );
  }

  return {
    structure,
    routes: uniqueRoutes.slice(0, MAX_REPORTED_ROUTES),
    models: models.slice(0, MAX_REPORTED_MODELS),
    functions: functions.slice(0, MAX_REPORTED_FUNCTIONS),
    environment: [...seen.values()]
      .map((entry) => ({
        name: entry.name,
        sources: [...entry.sources].sort(),
        kind: entry.kind,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, MAX_REPORTED_ENV),
    auth: authReport(uniqueRoutes, manifests, modelNames),
    database: databaseReport(manifests, modelNames.length),
    logs: {
      available: false,
      reason:
        'No log source is connected to this project, and this release has no runtime to produce one. Nothing is collected, so nothing is shown.',
      entries: [],
      redaction: 'applied-when-available',
    },
    manifests,
    recentChanges: (snapshot.recentChanges ?? [])
      .slice()
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, MAX_RECENT_CHANGES),
    scanned: {
      files: snapshot.files.length,
      read: snapshot.files.length,
      skipped: snapshot.skippedFiles ?? 0,
      truncated: snapshot.truncated === true,
    },
    warnings,
  };
}
