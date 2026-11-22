#!/usr/bin/env node
// The operational test data loader (operational test data design, phase 2): builds a complete,
// realistic marketplace in the LOCAL operational test environment by driving the running API the
// way the panels and the buyer site do, so every record passes the domain rules, the events, the
// mails and the audit. Never raw seeds: the only SQL is the guards' read of the database marker
// (and the claim vocabulary stand-in, until certification types can be created in the admin).
//
//   node scripts/ops-data/index.mjs [--market AU] [--only admin,catalog] [--backup]
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
import { acquireRun } from './lock.mjs';
import { adminPack } from './packs/admin.mjs';
import { catalogPack } from './packs/catalog.mjs';
import { certificatesPack } from './packs/certificates.mjs';
import { contentPack } from './packs/content.mjs';
import { ordersPack } from './packs/orders.mjs';
import { productsPack } from './packs/products.mjs';
import { sellersPack } from './packs/sellers.mjs';
import { approveOpen } from './packs/requests.mjs';
import { DATA_VERSION, STATE_DIR, readState, writeState } from './state.mjs';

/** The packs in the order they run. */
const PACKS = ['admin', 'catalog', 'sellers', 'products', 'content', 'orders'];
/** The packs of the ci profile (kept in step with scenarios/<MARKET>/ci.mjs, checked at start). */
const CI_DEFAULT = ['admin', 'catalog', 'sellers', 'products'];

/** The one password of every sample account (local machine only). */
const PASSWORD = process.env.OPS_PASSWORD ?? 'Mondapac-Ops-2026-Passw0rd!';

const { values } = parseArgs({
  options: {
    market: { type: 'string', default: 'AU' },
    only: { type: 'string' },
    // Passed by `ops-local.bat reset` to the loader it starts itself: the reset lock is its own.
    'within-reset': { type: 'boolean', default: false },
    // Save the finished database as the backup `ops-local.bat fast` restores (ops.mjs backup).
    backup: { type: 'boolean', default: false },
    // `ci` builds the small scenario of a pull request's CI run (scenarios/<MARKET>/ci.mjs): no
    // Stripe, no content, no orders. Unset, the full scenario.
    profile: { type: 'string' },
  },
});
const market = values.market.toUpperCase();
if (!/^[A-Z]{2}$/.test(market)) throw new Error(`--market must be a Market code such as AU`);
if (values.profile !== undefined && values.profile !== 'ci')
  throw new Error(`unknown --profile ${values.profile} (profiles: ci)`);
const ci = values.profile === 'ci';
const only =
  values.only === undefined
    ? values.profile === 'ci'
      ? CI_DEFAULT
      : PACKS
    : values.only.split(',').map((name) => name.trim());
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
// The ci profile needs no Stripe key; one that is set must still be a test-mode key.
assertStripeTestKey(process.env.STRIPE_SECRET_KEY);

const scenarioFile = resolve(ROOT, 'scripts/ops-data/scenarios', market, 'index.mjs');
if (!existsSync(scenarioFile))
  throw new Error(`no scenario for Market ${market} (${scenarioFile})`);
const { SCENARIO: FULL_SCENARIO } = await import(scenarioFile);
let SCENARIO = FULL_SCENARIO;
let CI_PACKS = PACKS;
if (ci) {
  const profileFile = resolve(ROOT, 'scripts/ops-data/scenarios', market, 'ci.mjs');
  if (!existsSync(profileFile))
    throw new Error(`Market ${market} has no ci profile (${profileFile})`);
  const profile = await import(profileFile);
  SCENARIO = profile.ciProfile(FULL_SCENARIO);
  CI_PACKS = profile.CI_PACKS;
  // The orders pack pays with Stripe and the content pack is large: neither runs in the profile,
  // and asking for one is an error, not a silent skip (a run that quietly built less would look
  // green). Without a Stripe key the orders pack is never reached.
  if (CI_PACKS.join() !== CI_DEFAULT.join()) throw new Error('CI_PACKS and CI_DEFAULT differ');
  const left = only.filter((name) => !CI_PACKS.includes(name));
  if (left.length > 0)
    throw new Error(
      `the ci profile does not run: ${left.join(', ')} (it runs ${CI_PACKS.join(', ')})`,
    );
}
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

const releaseLock = acquireRun(STATE_DIR, 'the loader', { withinReset: values['within-reset'] });
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

  log(
    `Operational test data for ${market} (data version ${DATA_VERSION}${ci ? ', ci profile' : ''}): ${only.join(', ')}`,
  );
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

  log('[admin] Platform admin and reviewer admin');
  // Every pack signs in as the admins; the admin pack always runs, so --only catalog works too.
  const { admin, reviewer } = await adminPack({
    scenario: SCENARIO,
    state,
    save,
    password: PASSWORD,
    log,
  });
  state.packs = { ...state.packs, admin: 'done' };
  save();

  // Later packs read what the catalog pack made, so it always runs (a rerun changes nothing).
  log('[catalog] Categories, attributes, feature sets, department links, cultures');
  const categoryIds = await catalogPack({ admin, reviewer, scenario: SCENARIO, log });
  state.packs = { ...state.packs, catalog: 'done' };
  save();

  const wants = (name) =>
    only.includes(name) || only.some((pack) => PACKS.indexOf(pack) > PACKS.indexOf(name));
  let sessions = new Map();
  if (wants('sellers')) {
    log('[sellers] Sellers in every onboarding state, store profiles, halal certificates');
    sessions = await sellersPack({
      admin,
      reviewer,
      scenario: SCENARIO,
      state,
      save,
      password: PASSWORD,
      log,
    });
    await certificatesPack({ admin, reviewer, scenario: SCENARIO, state, sessions, log });
    state.packs = { ...state.packs, sellers: 'done' };
    save();
  }
  if (only.includes('products')) {
    log('[products] Platform products, offers, tags, stock and prices');
    await productsPack({
      admin,
      reviewer,
      scenario: SCENARIO,
      categoryIds,
      sessions,
      state,
      save,
      log,
    });
    await approveOpen(reviewer, 'catalogue', log);
    state.packs = { ...state.packs, products: 'done' };
    save();
  }
  if (only.includes('content')) {
    log('[content] Slides, home page, navigation, information pages and the blog');
    await contentPack({ admin, reviewer, scenario: SCENARIO, categoryIds, state, log });
    state.packs = { ...state.packs, content: 'done' };
    save();
  }
  if (only.includes('orders')) {
    log('[orders] Buyers, address books, card payments (Stripe test mode), pickups, refunds');
    await ordersPack({
      admin,
      reviewer,
      scenario: SCENARIO,
      sessions,
      state,
      save,
      password: PASSWORD,
      log,
    });
    state.packs = { ...state.packs, orders: 'done' };
    save();
  }
  if (values.backup) {
    const saved = spawnSync(
      process.execPath,
      [resolve(ROOT, 'scripts/ops-data/ops.mjs'), 'backup'],
      {
        stdio: 'inherit',
      },
    );
    if (saved.status !== 0) throw new Error('the backup failed');
  }
  log(`Done. State: .local/ops-data/${market}.json`);
} finally {
  await db.end();
  releaseLock();
}
