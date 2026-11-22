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
// The Market code is required: there is no default Market (ADR-0020 decision 3).
// DEV_MARKETS_OUT_DIR changes the output folder (a test writes to a temporary one).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

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
if (
  mailOriginLimit !== undefined &&
  mailOriginLimit !== '' &&
  !(/^[1-9]\d{0,3}$/.test(mailOriginLimit) && Number(mailOriginLimit) <= 1000)
) {
  console.error('LOCAL_MAIL_ORIGIN_LIMIT must be a whole number from 1 to 1000');
  process.exit(1);
}
// Only for panels on this machine: a shared session (.devcontainer/share.sh, tunnel origins)
// keeps the committed limit even when the variable is left set in the shell.
const onThisMachine = (origin) => {
  const { hostname } = new URL(origin);
  return ['localhost', '127.0.0.1', '[::1]'].includes(hostname) || hostname.endsWith('.localhost');
};
if (
  mailOriginLimit !== undefined &&
  mailOriginLimit !== '' &&
  ![sellerOrigin, adminOrigin, ...(storefrontOrigin ? [storefrontOrigin] : [])].every(onThisMachine)
) {
  console.error(
    'LOCAL_MAIL_ORIGIN_LIMIT is refused: a panel or site origin is not on this machine',
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

if (mailOriginLimit !== undefined && mailOriginLimit !== '') {
  config.identity.mailThrottles.origin.limit = Number(mailOriginLimit);
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
