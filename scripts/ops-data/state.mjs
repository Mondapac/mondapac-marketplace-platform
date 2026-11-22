// The loader's local state: `.local/ops-data/<MARKET>.json` (never in the repository). It holds the
// data version the database was built with, the packs that finished, and the admin's
// authenticator secret, which the API never shows again.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from './guard.mjs';

export const LOCAL = resolve(ROOT, '.local');
export const STATE_DIR = resolve(LOCAL, 'ops-data');

export const stateFile = (market) => resolve(STATE_DIR, `${market}.json`);

export function readState(market) {
  const file = stateFile(market);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
}

export function writeState(market, state) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(stateFile(market), `${JSON.stringify(state, null, 2)}\n`);
}
