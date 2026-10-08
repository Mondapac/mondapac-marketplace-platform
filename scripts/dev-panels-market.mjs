#!/usr/bin/env node
// Local development only: writes a copy of a Market's configuration under .local/markets/ whose
// panel links and allowed origins point at the panels on `*.localhost`, so the mail links a
// developer opens in a browser reach `pnpm dev:seller`. The committed config stays untouched.
//
//   node scripts/dev-panels-market.mjs AU
//   MARKET_CONFIG_DIR=.local/markets pnpm dev
//
// The Market code is required: there is no default Market (ADR-0020 decision 3).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const code = process.argv[2];
if (code === undefined || !/^[A-Z]{2}$/.test(code)) {
  console.error('usage: node scripts/dev-panels-market.mjs <MARKET>   (for example AU)');
  process.exit(1);
}
const sellerOrigin = process.env.SELLER_PANEL_ORIGIN ?? 'http://seller.localhost:3001';
const adminOrigin = process.env.ADMIN_PANEL_ORIGIN ?? 'http://admin.localhost:3002';

const source = resolve('config/markets', `${code}.json`);
const config = JSON.parse(await readFile(source, 'utf8'));
const targets = config.identity.links.targets;
for (const [page, url] of Object.entries(targets.seller)) {
  targets.seller[page] = `${sellerOrigin}${new URL(url).pathname}`;
}
for (const [page, url] of Object.entries(targets.admin)) {
  targets.admin[page] = `${adminOrigin}${new URL(url).pathname}`;
}
config.allowedOrigins = [sellerOrigin, adminOrigin];

const directory = resolve('.local/markets');
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, `${code}.json`), `${JSON.stringify(config, null, 2)}\n`);
console.log(
  `wrote .local/markets/${code}.json; start the API with MARKET_CONFIG_DIR=.local/markets`,
);
