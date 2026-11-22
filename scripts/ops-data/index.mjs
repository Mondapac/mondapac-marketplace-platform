#!/usr/bin/env node
// The operational test data loader (operational test data design, phase 2): builds a complete,
// realistic marketplace in the LOCAL operational test environment by driving the running API the
// way the panels and the buyer site do, so every record passes the domain rules, the events, the
// mails and the audit. Never raw seeds: the only SQL is the guards' read of the database marker
// (and the claim vocabulary stand-in, until certification types can be created in the admin).
//
//   node scripts/ops-data/index.mjs [--market AU] [--only admin,catalog]
//
// Needs the API and the worker running (the worker with CATALOG_SEED_JOBS_OFF, see README.md) and
// Mailpit. Runs the scenario packs of the Market in order; each pack creates only what is missing,
// so a rerun changes nothing. Refuses to run unless every guard in guard.mjs holds.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { connect } from './db.mjs';
import {
  ROOT,
  assertDatabaseMarker,
  assertLocalDevelopment,
  assertStripeTestKey,
  loadDotEnv,
} from './guard.mjs';
import { API, MAILPIT, sleep } from './lib.mjs';
import { adminPack } from './packs/admin.mjs';
import { catalogPack } from './packs/catalog.mjs';
import { readState, writeState } from './state.mjs';

/**
 * The version of the scenario data. A database built with another version is not topped up: the
 * loader stops and asks for a rebuild, so a run never mixes two scenario shapes. Raise it when a
 * change to a scenario would not converge on an existing database (a renamed slug or code).
 */
export const DATA_VERSION = 1;

/** The packs in the order they run; later phases add sellers, buyers and orders, and content. */
const PACKS = ['admin', 'catalog'];

/** The one password of every sample account (local machine only). */
const PASSWORD = process.env.OPS_PASSWORD ?? 'Mondapac-Ops-2026-Passw0rd!';

const { values } = parseArgs({
  options: { market: { type: 'string', default: 'AU' }, only: { type: 'string' } },
});
const market = values.market.toUpperCase();
if (!/^[A-Z]{2}$/.test(market)) throw new Error(`--market must be a Market code such as AU`);
const only = values.only === undefined ? PACKS : values.only.split(',').map((name) => name.trim());
const unknown = only.filter((name) => !PACKS.includes(name));
if (unknown.length > 0)
  throw new Error(`unknown pack(s): ${unknown.join(', ')} (packs: ${PACKS.join(', ')})`);

loadDotEnv();
const DB_URL = process.env.MIGRATION_DATABASE_URL;
assertLocalDevelopment({
  urls: {
    OPS_API_URL: API,
    MAIL_CATCHER_URL: MAILPIT,
    ...(DB_URL ? { MIGRATION_DATABASE_URL: DB_URL } : {}),
  },
});
if (!DB_URL) throw new Error('MIGRATION_DATABASE_URL is not set (copy .env.example to .env).');
assertStripeTestKey(process.env.STRIPE_SECRET_KEY);

const scenarioFile = resolve(ROOT, 'scripts/ops-data/scenarios', market, 'index.mjs');
if (!existsSync(scenarioFile))
  throw new Error(`no scenario for Market ${market} (${scenarioFile})`);
const { SCENARIO } = await import(scenarioFile);
if (SCENARIO.market !== market)
  throw new Error(`the ${market} scenario names Market ${SCENARIO.market}`);

const log = (message) => console.log(message);

async function waitFor(label, check, seconds) {
  for (let waited = 0; waited < seconds; waited += 2) {
    if (await check()) return;
    await sleep(2000);
  }
  throw new Error(`${label} did not become ready within ${seconds} s`);
}

const reachable = (url) => async () => {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
};

const db = await connect(DB_URL);
try {
  await assertDatabaseMarker(db);
  const state = readState(market);
  if (state.dataVersion !== undefined && state.dataVersion !== DATA_VERSION) {
    throw new Error(
      `This database was built with scenario data version ${state.dataVersion}; the loader is at ` +
        `${DATA_VERSION}. Rebuild the database (ops reset), delete .local/ops-data/ and run again.`,
    );
  }
  state.dataVersion = DATA_VERSION;
  state.market = market;
  const save = () => writeState(market, state);
  save();

  log(`Operational test data for ${market} (data version ${DATA_VERSION}): ${only.join(', ')}`);
  // The claim vocabulary stand-in: catalog refuses every name while the Market has no published
  // certification type, and certification types cannot be created in the admin yet.
  const vocabulary = spawnSync(
    process.execPath,
    [resolve(ROOT, 'scripts/demo-seed/claim-vocabulary.mjs')],
    { stdio: 'inherit', env: { ...process.env, DEMO_MARKET: market } },
  );
  if (vocabulary.status !== 0) throw new Error('the claim vocabulary step failed');
  await waitFor('the API (is `pnpm dev` running?)', reachable(`${API}/health`), 300);
  await waitFor(
    'the mail catcher (Mailpit, docker compose up -d)',
    reachable(`${MAILPIT}/api/v1/info`),
    60,
  );

  log('[admin] Platform admin');
  // Every pack signs in as the admin; the admin pack always runs, so --only catalog works too.
  const admin = await adminPack({ scenario: SCENARIO, state, save, password: PASSWORD, log });
  state.packs = { ...state.packs, admin: 'done' };
  save();

  if (only.includes('catalog')) {
    log('[catalog] Categories, attributes, feature sets, department links, cultures');
    await catalogPack({ admin, reviewer: null, scenario: SCENARIO, log });
    state.packs = { ...state.packs, catalog: 'done' };
    save();
  }
  log(`Done. State: .local/ops-data/${market}.json`);
} finally {
  await db.end();
}
