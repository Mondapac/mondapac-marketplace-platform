#!/usr/bin/env node
// `ops refresh` (operational test data design, phase 3): adds fresh activity to the finished local
// operational test database without deleting anything, so dashboards and lists show today's data.
//
//   node scripts/ops-data/refresh.mjs [--market AU] [--orders 6]
//
// Needs the API, the worker and Mailpit running and the loader finished (the state file of the
// Market, the same data version). Takes the loader's run lock, so it cannot overlap a reset, a fast
// restore or a loader run. Refuses to run unless every guard in guard.mjs holds (local development,
// the operational test marker, a test-mode Stripe key). Without a Stripe test key the shelves and
// special prices are still refreshed and the orders are left out. See packs/refresh.mjs.
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
import { API, MAILPIT } from './lib.mjs';
import { acquireRun } from './lock.mjs';
import { adminPack } from './packs/admin.mjs';
import { refreshPack } from './packs/refresh.mjs';
import { DATA_VERSION, STATE_DIR, readState, stateFile, writeState } from './state.mjs';

const PASSWORD = process.env.OPS_PASSWORD ?? 'Mondapac-Ops-2026-Passw0rd!';
const MAX_ORDERS = 20;

const { values } = parseArgs({
  options: {
    market: { type: 'string', default: 'AU' },
    orders: { type: 'string', default: '6' },
  },
});
const market = values.market.toUpperCase();
if (!/^[A-Z]{2}$/.test(market)) throw new Error('--market must be a Market code such as AU');
const orders = Number(values.orders);
if (!Number.isInteger(orders) || orders < 0 || orders > MAX_ORDERS) {
  throw new Error(`--orders must be a whole number from 0 to ${MAX_ORDERS}`);
}

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
const withOrders = orders > 0 && Boolean(process.env.STRIPE_SECRET_KEY);

const scenarioFile = resolve(ROOT, 'scripts/ops-data/scenarios', market, 'index.mjs');
if (!existsSync(scenarioFile))
  throw new Error(`no scenario for Market ${market} (${scenarioFile})`);
const { SCENARIO } = await import(scenarioFile);

const state = readState(market);
if (state.dataVersion !== DATA_VERSION || state.packs?.products !== 'done') {
  throw new Error(
    `There is no finished operational test database for ${market} (${stateFile(market)}). ` +
      'Run scripts\\ops-local.bat first; a refresh only adds to what the loader built.',
  );
}

const releaseLock = acquireRun(STATE_DIR, 'refresh');
const db = await connect(DB_URL);
try {
  await assertDatabaseMarker(db);
  const save = () => writeState(market, state);
  const log = (message) => console.log(message);
  log(`Refreshing the operational test data for ${market}${withOrders ? '' : ' (no orders)'}`);
  const { admin, reviewer } = await adminPack({
    scenario: SCENARIO,
    state,
    save,
    password: PASSWORD,
    log,
  });
  await refreshPack({
    admin,
    reviewer,
    scenario: SCENARIO,
    state,
    save,
    password: PASSWORD,
    log,
    orders: withOrders ? orders : 0,
  });
  log('Done.');
} finally {
  await db.end();
  releaseLock();
}
