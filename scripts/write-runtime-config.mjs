#!/usr/bin/env node
/**
 * Writes the public runtime configuration that the packaged application reads.
 *
 * The web build carries no environment variables (the frontend boundary test
 * forbids it) and an installed APK cannot be reconfigured afterwards, so the
 * backend location is baked into one small public JSON file at build time.
 *
 * Usage: node scripts/write-runtime-config.mjs "https://api.example.com"
 *        node scripts/write-runtime-config.mjs ""        (same origin)
 *
 * Only a PUBLIC base URL belongs here. Provider keys never go in this file: they
 * live in the backend vault, and the Android build would ship them to every
 * device that installs the APK.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'apps/web/public/runtime-config.json');
const raw = (process.argv[2] ?? '').trim();

function fail(message) {
  console.error(`runtime-config: ${message}`);
  process.exit(1);
}

let apiBaseUrl = '';
if (raw.length > 0) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(`"${raw}" is not a URL. Expected something like https://api.example.com`);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    fail('the API base URL must use https (plain http is accepted only for loopback).');
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    fail('the API base URL must not carry a query string or a fragment.');
  }
  apiBaseUrl = `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

writeFileSync(target, `${JSON.stringify({ apiBaseUrl }, null, 2)}\n`);
console.log(
  apiBaseUrl === ''
    ? 'runtime-config: same-origin (no backend URL set)'
    : `runtime-config: ${apiBaseUrl}`,
);
