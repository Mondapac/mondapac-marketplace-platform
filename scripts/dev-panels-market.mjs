#!/usr/bin/env node
// Local development only: writes a copy of a Market's configuration under .local/markets/ whose
// panel links and allowed origins point at the panels on `*.localhost`, so the mail links a
// developer opens in a browser reach `pnpm dev:seller`. The committed config stays untouched.
//
//   node scripts/dev-panels-market.mjs AU
//   MARKET_CONFIG_DIR=.local/markets pnpm dev
//
// It also writes .local/service-areas/<CODE>.json with the Market's service areas switched on
// for seller onboarding and delivery, so a local demo can onboard Brisbane sellers
// (SERVICE_AREA_CONFIG_DIR=.local/service-areas). The committed file stays untouched.
//
// LOCAL_MAIL_ORIGIN_LIMIT (opt-in, 1 to 1000) raises the per-address limit of sign-up and
// verification mails (identity.mailThrottles.origin.limit), because every local client shares the
// address 127.0.0.1: the operational test data loader (scripts/ops-data) signs up a few dozen
// accounts in one run. The per-account limit stays as committed. Unset, nothing changes.
//
// LOCAL_SIGN_IN_ORIGIN_LIMIT (opt-in, 1 to 1000) raises, the same way and for the same reason, the
// per-address limit of sign-ins (identity.signInThrottles.origin.limit; confirming a buyer's email
// counts as a sign-in): the loader's orders pack signs in thirty buyers after the sellers. The
// per-account and per-account-and-address limits stay as committed. Unset, nothing changes.
//
// LOCAL_REFUND_CREDIT=1 (opt-in, owner decision of 22 Nov 2026) switches on tax.refundCredit.enabled
// in the local Market file only, so the loader's orders pack can cancel and refund test-mode
// orders and the refund screens can be tried. The committed file stays off until the registered
// tax agent confirms in writing. Only 1 is accepted; unset, nothing changes.
//
// The Market code is required: there is no default Market (ADR-0020 decision 3).
// DEV_MARKETS_OUT_DIR changes the output folder (a test writes to a temporary one).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertStripeTestKey, loadDotEnv } from './ops-data/guard.mjs';

const code = process.argv[2];
if (code === undefined || !/^[A-Z]{2}$/.test(code)) {
  console.error('usage: node scripts/dev-panels-market.mjs <MARKET>   (for example AU)');
  process.exit(1);
}
const sellerOrigin = process.env.SELLER_PANEL_ORIGIN ?? 'http://seller.localhost:3001';
const adminOrigin = process.env.ADMIN_PANEL_ORIGIN ?? 'http://admin.localhost:3002';
// Opt-in: the buyer site's origin (the local demo's slot is http://storefront.localhost:3003).
// Unset, the customer list and links stay as committed and no unsafe customer request is allowed.
const storefrontOrigin = process.env.STOREFRONT_ORIGIN;

const mailOriginLimit = process.env.LOCAL_MAIL_ORIGIN_LIMIT;
const signInOriginLimit = process.env.LOCAL_SIGN_IN_ORIGIN_LIMIT;
const refundCredit = process.env.LOCAL_REFUND_CREDIT;
const given = (value) => value !== undefined && value !== '';
if (given(refundCredit) && refundCredit !== '1') {
  console.error('LOCAL_REFUND_CREDIT must be 1 (or unset)');
  process.exit(1);
}
// Refunds move money: switched on only for an API whose Stripe key is a test-mode one (the same
// .env the API reads; a variable already set wins, as in the API). Unset, there is nothing to
// refund with, so the switch is refused too (Hassan, PR 1245).
if (given(refundCredit)) {
  loadDotEnv();
  const key = process.env.STRIPE_SECRET_KEY;
  if (key === undefined || key === '') {
    console.error('LOCAL_REFUND_CREDIT needs STRIPE_SECRET_KEY, a Stripe test-mode key');
    process.exit(1);
  }
  try {
    assertStripeTestKey(key);
  } catch {
    console.error(
      'LOCAL_REFUND_CREDIT is refused: STRIPE_SECRET_KEY is not a Stripe test-mode key',
    );
    process.exit(1);
  }
}
for (const [name, value] of [
  ['LOCAL_MAIL_ORIGIN_LIMIT', mailOriginLimit],
  ['LOCAL_SIGN_IN_ORIGIN_LIMIT', signInOriginLimit],
]) {
  if (given(value) && !(/^[1-9]\d{0,3}$/.test(value) && Number(value) <= 1000)) {
    console.error(`${name} must be a whole number from 1 to 1000`);
    process.exit(1);
  }
}
// Only for panels on this machine: a shared session (.devcontainer/share.sh, tunnel origins)
// keeps the committed limits even when a variable is left set in the shell.
const onThisMachine = (origin) => {
  const { hostname } = new URL(origin);
  return ['localhost', '127.0.0.1', '[::1]'].includes(hostname) || hostname.endsWith('.localhost');
};
if (
  (given(mailOriginLimit) || given(signInOriginLimit) || given(refundCredit)) &&
  ![sellerOrigin, adminOrigin, ...(storefrontOrigin ? [storefrontOrigin] : [])].every(onThisMachine)
) {
  console.error(
    'LOCAL_MAIL_ORIGIN_LIMIT, LOCAL_SIGN_IN_ORIGIN_LIMIT and LOCAL_REFUND_CREDIT are refused: a panel or site origin is not on this machine',
  );
  process.exit(1);
}

const source = resolve('config/markets', `${code}.json`);
const config = JSON.parse(await readFile(source, 'utf8'));
const targets = config.identity.links.targets;
for (const [page, url] of Object.entries(targets.seller)) {
  targets.seller[page] = `${sellerOrigin}${new URL(url).pathname}`;
}
for (const [page, url] of Object.entries(targets.admin)) {
  targets.admin[page] = `${adminOrigin}${new URL(url).pathname}`;
}
if (storefrontOrigin !== undefined && storefrontOrigin !== '') {
  for (const [page, url] of Object.entries(targets.customer ?? {})) {
    targets.customer[page] = `${storefrontOrigin}${new URL(url).pathname}`;
  }
}
// One list per route population (identity design 6.4): each panel's origin on its own list; the
// customer list stays as committed when it is a list of origins (the storefront is not served
// locally), and is empty otherwise (Hassan, PR #179 L1).
const committedCustomer = config.allowedOrigins?.customer;
config.allowedOrigins = {
  admin: [adminOrigin],
  seller: [sellerOrigin],
  customer:
    storefrontOrigin !== undefined && storefrontOrigin !== ''
      ? [storefrontOrigin]
      : Array.isArray(committedCustomer) &&
          committedCustomer.every((origin) => typeof origin === 'string')
        ? committedCustomer
        : [],
};

if (given(mailOriginLimit)) {
  config.identity.mailThrottles.origin.limit = Number(mailOriginLimit);
}
if (given(signInOriginLimit)) {
  config.identity.signInThrottles.origin.limit = Number(signInOriginLimit);
}
if (given(refundCredit)) {
  config.tax = { ...config.tax, refundCredit: { ...config.tax?.refundCredit, enabled: true } };
}

const directory = resolve(process.env.DEV_MARKETS_OUT_DIR ?? '.local/markets');
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, `${code}.json`), `${JSON.stringify(config, null, 2)}\n`);
console.log(`wrote ${directory}/${code}.json; start the API with MARKET_CONFIG_DIR=${directory}`);

const areasSource = resolve('config/service-areas', `${code}.json`);
const areas = JSON.parse(await readFile(areasSource, 'utf8'));
for (const area of areas.areas) {
  area.sellerOnboardingEnabled = true;
  area.deliveryEnabled = true;
}
const areasDirectory = resolve(process.env.DEV_SERVICE_AREAS_OUT_DIR ?? '.local/service-areas');
await mkdir(areasDirectory, { recursive: true });
await writeFile(resolve(areasDirectory, `${code}.json`), `${JSON.stringify(areas, null, 2)}\n`);
console.log(
  `wrote ${areasDirectory}/${code}.json; start the API with SERVICE_AREA_CONFIG_DIR=${areasDirectory}`,
);
