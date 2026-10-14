// The demo seed's production guard. It refuses to run unless every target is this machine and
// the environment is not production. A demo has no business anywhere else, so there is no flag
// that switches the guard off.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Reads the repository's `.env` without overriding variables already set (as the API does). */
export function loadDotEnv() {
  const file = resolve(ROOT, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const found = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (found && !(found[1] in process.env)) process.env[found[1]] = found[2];
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const isLocalHost = (host) => LOCAL_HOSTS.has(host) || host.endsWith('.localhost');

/** Throws unless the environment is a local development one. */
export function assertLocalDevelopment({ urls }) {
  const problems = [];
  const env = process.env.NODE_ENV;
  if (env !== undefined && env !== '' && env !== 'development' && env !== 'test') {
    problems.push(`NODE_ENV is "${env}"; the demo seed runs only in development or test`);
  }
  for (const [name, value] of Object.entries(urls)) {
    let host;
    try {
      const url = new URL(value);
      host = url.hostname;
      for (const key of ['host', 'hostaddr', 'service']) {
        if (url.searchParams.has(key)) problems.push(`${name} overrides the host with "${key}"`);
      }
    } catch {
      problems.push(`${name} is not a URL`);
      continue;
    }
    if (!isLocalHost(host)) problems.push(`${name} points at "${host}", not at this machine`);
  }
  if (problems.length > 0) {
    throw new Error(`The demo seed refuses to run:\n  - ${problems.join('\n  - ')}`);
  }
}
