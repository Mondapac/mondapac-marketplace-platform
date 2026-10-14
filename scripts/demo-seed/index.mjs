#!/usr/bin/env node
// The demo seed: fills a LOCAL development database with a small Brisbane marketplace by
// driving the running API like the panels do, so every record passes the domain rules. See
// handoffs/demo-env.md (and docs/process/demo-seed.md) for how to run it.
//
//   node scripts/demo-seed/index.mjs
//
// Needs the API and the worker running, and the mail catcher (Mailpit). Idempotent: run it twice
// and the second run changes nothing. It refuses to run against anything but this machine
// (guard.mjs). Sample logins are written to .local/demo-credentials.txt, never to the repository.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, assertLocalDevelopment, loadDotEnv } from './guard.mjs';
import { API, MAILPIT, MARKET, ORIGINS, Session, adminSignIn, mailLink, sleep } from './lib.mjs';
import { ADMIN, BUYER, HELD, OFFERS, PASSWORD, PRODUCTS, SELLERS, SPECIAL } from './data.mjs';

loadDotEnv();
const DB_URL = process.env.MIGRATION_DATABASE_URL;
assertLocalDevelopment({
  urls: {
    DEMO_API_URL: API,
    MAIL_CATCHER_URL: MAILPIT,
    ...(DB_URL ? { MIGRATION_DATABASE_URL: DB_URL } : {}),
  },
});
if (!DB_URL) throw new Error('MIGRATION_DATABASE_URL is not set (copy .env.example to .env).');

const LOCAL = resolve(ROOT, '.local');
const STATE_FILE = resolve(LOCAL, 'demo-state.json');
const CREDENTIALS_FILE = resolve(LOCAL, 'demo-credentials.txt');
const LOCALE = 'en-AU';
const log = (message) => console.log(message);
const readState = () =>
  existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
const writeState = (state) => {
  mkdirSync(LOCAL, { recursive: true });
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
};

const { Client } = createRequire(resolve(ROOT, 'apps/api/package.json'))('pg');
const db = new Client({ connectionString: DB_URL });

async function waitFor(label, check, seconds = 120) {
  for (let waited = 0; waited < seconds; waited += 2) {
    if (await check()) return;
    await sleep(2000);
  }
  throw new Error(`${label} did not become ready within ${seconds} s`);
}

// 1. Claim vocabulary and the API ---------------------------------------------------------------
async function prepare() {
  log('[1/8] Checking the API, the mail catcher and the catalog seed');
  const run = spawnSync(
    process.execPath,
    [resolve(ROOT, 'scripts/demo-seed/claim-vocabulary.mjs')],
    {
      stdio: 'inherit',
    },
  );
  if (run.status !== 0) throw new Error('the claim vocabulary step failed');
  await waitFor('the API (is `pnpm dev` running?)', async () => {
    try {
      return (await fetch(`${API}/health`)).ok;
    } catch {
      return false;
    }
  });
  await waitFor('the mail catcher (Mailpit, docker compose up -d)', async () => {
    try {
      return (await fetch(`${MAILPIT}/api/v1/info`)).ok;
    } catch {
      return false;
    }
  });
  // The catalog jobs run when the worker starts; they need the vocabulary above.
  await waitFor(
    'the catalog categories and attributes (is the worker running? restart it after the vocabulary step)',
    async () => {
      const categories = await db.query(
        'SELECT count(*)::int AS n FROM catalog.platform_categories',
      );
      const attributes = await db.query(
        'SELECT count(*)::int AS n FROM catalog.attribute_definitions',
      );
      const families = await db.query('SELECT count(*)::int AS n FROM catalog.attribute_families');
      return categories.rows[0].n > 0 && attributes.rows[0].n > 3 && families.rows[0].n > 0;
    },
    300,
  );
}

// 2. The platform admin -------------------------------------------------------------------------
function firstAdminInvitation() {
  const entry = resolve(ROOT, 'apps/api/dist/identity-admin.js');
  if (!existsSync(entry)) {
    throw new Error(
      'apps/api/dist/identity-admin.js is missing: build the API first (pnpm --filter @mondapac/api build)',
    );
  }
  // The API refuses to start with the migration role's URL in its environment.
  const env = { ...process.env };
  delete env.MIGRATION_DATABASE_URL;
  const run = spawnSync(
    process.execPath,
    [entry, 'first-admin', '--market', MARKET, '--email', ADMIN.email],
    {
      env: {
        MARKET_CONFIG_DIR: resolve(LOCAL, 'markets'),
        SERVICE_AREA_CONFIG_DIR: resolve(LOCAL, 'service-areas'),
        ...env,
        APP_ROLE: 'api',
      },
      encoding: 'utf8',
    },
  );
  const out = run.stdout.trim().split('\n').pop() ?? '';
  if (run.status === 0) return 'issued';
  if (run.status === 2) return out.includes('first-admin.exists') ? 'exists' : `declined: ${out}`;
  throw new Error(
    `first-admin failed (exit ${run.status}): ${run.stderr.split('\n').slice(-4).join(' | ')}`,
  );
}

async function ensureAdmin(state) {
  log('[2/8] Platform admin');
  if (state.admin?.secret) return adminSignIn(ADMIN.email, PASSWORD, state.admin.secret);
  const since = Date.now() - 2000;
  const outcome = firstAdminInvitation();
  if (outcome === 'exists') {
    throw new Error(
      'The database already has an admin that this seed did not create, so its authenticator secret is unknown.\n' +
        'Reset the demo database (see handoffs/demo-env.md) and run the seed again.',
    );
  }
  if (outcome !== 'issued') throw new Error(`first-admin: ${outcome}`);
  const token = await mailLink(ADMIN.email, /#(mi1_\S+)/, { since });
  const anonymous = new Session('admin');
  const enrolment = await anonymous.ok('POST', '/identity/admin/invitation/enrolment', { token });
  const { totp } = await import('./lib.mjs');
  await anonymous.ok('POST', '/identity/admin/invitation/accept', {
    token,
    displayName: ADMIN.displayName,
    password: PASSWORD,
    secret: enrolment.secret,
    tag: enrolment.tag,
    expiresAt: enrolment.expiresAt,
    code: totp(enrolment.secret),
  });
  state.admin = { email: ADMIN.email, secret: enrolment.secret, otpauthUri: enrolment.otpauthUri };
  writeState(state);
  return adminSignIn(ADMIN.email, PASSWORD, enrolment.secret);
}

// 3. Sellers ------------------------------------------------------------------------------------
async function sellerSignIn(seller) {
  const session = new Session('seller');
  const answer = await session.request('POST', '/identity/seller/sign-in', {
    email: seller.email,
    password: PASSWORD,
  });
  return answer.status === 200 ? { session, access: answer.body.sellerAccess } : null;
}

async function ensureSeller(admin, seller) {
  let signedIn = await sellerSignIn(seller);
  if (signedIn === null) {
    const since = Date.now() - 2000;
    const anonymous = new Session('seller');
    await anonymous.ok('POST', '/identity/seller/sign-up', {
      displayName: seller.owner,
      email: seller.email,
      password: PASSWORD,
    });
    const token = await mailLink(seller.email, /#(ml1_\S+)/, { since });
    await anonymous.ok('POST', '/identity/seller/confirm-email', { token, password: PASSWORD });
    signedIn = await sellerSignIn(seller);
    if (signedIn === null)
      throw new Error(`${seller.key}: cannot sign in after confirming the email`);
  }
  if (signedIn.access === 'approved') return signedIn.session;

  const s = signedIn.session;
  if (seller.leaveInReview) {
    const waiting = await admin.ok('POST', '/sellers/admin/list', { tab: 'awaiting-review' });
    if (waiting.items.some((item) => item.slug === seller.slug)) return null;
  }
  // The worker creates the file from the sign-up event; wait for it.
  await waitFor(
    `${seller.key}: the seller file (is the worker running?)`,
    async () => (await s.get('/sellers/my-file')).status === 200,
    60,
  );
  await s.ok('PUT', '/sellers/my-file/general', {
    storeName: seller.storeName,
    businessName: seller.businessName,
    phone: seller.phone,
  });
  await s.ok('PUT', '/sellers/my-file/address', {
    address: seller.address,
    timezone: 'Australia/Brisbane',
  });
  await s.ok('PUT', '/sellers/my-file/slug', { slug: seller.slug });
  await s.ok('PUT', '/sellers/my-file/identifier', { identifier: seller.abn });
  const submitted = await s.post('/sellers/my-file/submit', {});
  if (submitted.status !== 200 && submitted.body?.code !== 'file.already-submitted') {
    throw new Error(
      `${seller.key}: submit -> ${submitted.status} ${JSON.stringify(submitted.body)}`,
    );
  }

  if (seller.leaveInReview) return null;
  const list = await admin.ok('POST', '/sellers/admin/list', { tab: 'awaiting-review' });
  const row = list.items.find((item) => item.slug === seller.slug);
  if (!row) throw new Error(`${seller.key}: not in the awaiting-review list`);
  const review = await admin.ok('GET', `/sellers/admin/${row.sellerId}/review`);
  const revisionId = review.current.id;
  await admin.ok('PUT', `/sellers/admin/${row.sellerId}/review/manual-register-check`, {
    revisionId,
    observedOutcome: 'active',
  });
  await admin.ok('POST', `/sellers/admin/${row.sellerId}/review/approve`, { revisionId });
  // The approval reaches identity through an event; wait for the seller's access to follow.
  let again = null;
  await waitFor(
    `${seller.key}: seller access to become approved (is the worker running?)`,
    async () => {
      again = await sellerSignIn(seller);
      return again?.access === 'approved';
    },
    90,
  );
  return again.session;
}

// 4. Products -----------------------------------------------------------------------------------
const productIds = new Map();

/** The variant ids of a published product in the order its content lists them. */
async function variantOrder(productId) {
  const rows = await db.query(
    `SELECT v.variant_id FROM catalog.product_revision_variants v
       JOIN catalog.products p ON p.published_revision_id = v.revision_id
      WHERE p.id = $1 AND p.market_id = $2 ORDER BY v.position`,
    [productId, MARKET],
  );
  return rows.rows.map((row) => row.variant_id);
}

async function ensureProduct(admin, product, categoryIds) {
  const found = await db.query(
    `SELECT p.id FROM catalog.products p
       JOIN catalog.product_revision_texts t ON t.revision_id = p.published_revision_id
      WHERE p.market_id = $1 AND t.locale = $2 AND t.name = $3 LIMIT 1`,
    [MARKET, LOCALE, product.name],
  );
  if (found.rowCount > 0) {
    productIds.set(product.key, found.rows[0].id);
    return false;
  }
  const configurable = product.variants !== undefined;
  const created = await admin.ok('POST', '/catalog/admin/platform-products', {
    typeCode: configurable ? 'configurable' : 'simple',
  });
  const content = (variantIds) => ({
    texts: {
      [LOCALE]: { name: product.name, shortDescription: product.short, description: product.text },
    },
    categoryIds: [categoryIds.get(product.category)],
    taxCategoryCode: product.tax,
    attributeValues: {
      brand: product.brand,
      description: { [LOCALE]: product.text },
      'country-of-origin': product.origin,
    },
    variants: configurable
      ? product.variants.map((variant, index) => ({
          variantId: variantIds[index],
          optionValues: { 'pack-size': variant.option },
          labels: { [LOCALE]: variant.label },
        }))
      : created.variantIds.map((variantId) => ({ variantId, labels: { [LOCALE]: product.name } })),
  });
  let variantIds = created.variantIds;
  if (configurable) {
    // New variants are named by a placeholder id; the server mints the real ones on the first save.
    const first = await admin.ok(
      'PUT',
      `/catalog/admin/platform-products/${created.productId}/draft`,
      {
        variantIds: product.variants.map(() => null),
        content: content(product.variants.map((_, index) => `new${index + 1}`)),
      },
    );
    variantIds = first.variantIds;
  }
  const saved = await admin.ok(
    'PUT',
    `/catalog/admin/platform-products/${created.productId}/draft`,
    {
      variantIds,
      content: content(variantIds),
    },
  );
  if (saved.refusedFields.length > 0) {
    throw new Error(`${product.key}: texts refused: ${JSON.stringify(saved.refusedFields)}`);
  }
  const submitted = await admin.ok(
    'POST',
    `/catalog/admin/platform-products/${created.productId}/submit`,
    {
      replacePending: false,
    },
  );
  if (!submitted.published) throw new Error(`${product.key}: not published`);
  productIds.set(product.key, created.productId);
  return true;
}

// 5. Offers, stock and prices --------------------------------------------------------------------
async function ensureOffers(admin, seller, session) {
  const existing = await session.ok('GET', '/catalog/seller/offers');
  const bySku = new Map(existing.items.map((item) => [item.sellerSku, item]));
  const offerIds = new Map();
  for (const entry of OFFERS[seller.key]) {
    let offer = bySku.get(entry.sku);
    let offerId = offer?.offerId;
    if (!offer) {
      const created = await session.ok('POST', '/catalog/seller/offers', {
        productId: productIds.get(entry.product),
        sellerSku: entry.sku,
        conditionCode: 'new',
        description: { [LOCALE]: PRODUCTS.find((p) => p.key === entry.product).short },
      });
      offerId = created.offerId;
      offer = { status: 'draft' };
    }
    offerIds.set(entry.sku, offerId);
    if (offer.status === 'draft' || offer.status === 'changes-needed') {
      // Catalog's set-handling package is not built yet, so a submit would fail with
      // offer.handling-missing: the seed records the handling in the database. Remove this
      // step when the package lands.
      await db.query(
        `UPDATE catalog.offers SET handling = $1, version = version + 1
          WHERE id = $2 AND market_id = $3 AND handling IS NULL`,
        [entry.handling, offerId, MARKET],
      );
      await session.ok('POST', `/catalog/seller/offers/${offerId}/submit`, {});
      offer = { status: 'pending-first-publish' };
    }
    if (offer.status === 'pending-first-publish') {
      const queue = await admin.ok('GET', '/catalog/admin/review-queue?limit=50');
      const row = queue.items.find((item) => item.offerId === offerId);
      if (row)
        await admin.ok('POST', `/catalog/admin/offers/${offerId}/approve`, {
          version: row.version,
        });
    }
  }
  return offerIds;
}

async function ensureStockAndPrices(seller, session, offerIds, writes) {
  const sources = await session.ok('GET', '/inventory/seller/sources');
  const source = sources.sources.find((item) => item.isDefault) ?? sources.sources[0];
  if (source.address === null) {
    await session.ok('PUT', `/inventory/seller/sources/${source.id}`, {
      expectedVersion: sources.version,
      name: seller.stockName,
      address: seller.address,
      timeZone: 'Australia/Brisbane',
    });
  }
  for (const entry of OFFERS[seller.key]) {
    const offerId = offerIds.get(entry.sku);
    const stock = await session.ok('GET', `/inventory/seller/offers/${offerId}/stock`);
    const prices = await session.ok('GET', `/pricing/seller/offers/${offerId}/prices`);
    const variantIds = await variantOrder(productIds.get(entry.product));
    for (const [index, variantId] of variantIds.entries()) {
      const row = stock.variants.find((variant) => variant.variantId === variantId).sources[0];
      if (row.onHand === 0) {
        await session.ok(
          'PUT',
          `/inventory/seller/offers/${offerId}/variants/${variantId}/sources/${source.id}/stock`,
          {
            onHand: entry.stock[index],
            expectedVersion: row.version,
          },
        );
      }
      const price = prices.variants.find((variant) => variant.variantId === variantId);
      if (price.inForce === null && price.held === null) {
        const written = await session.ok(
          'PUT',
          `/pricing/seller/offers/${offerId}/variants/${variantId}/regular-price`,
          {
            amount: String(entry.prices[index]),
            currency: 'AUD',
            expectedVersion: price.seriesVersion ?? null,
          },
        );
        writes.set(`${entry.sku}:${index}`, { offerId, variantId, version: written.seriesVersion });
      }
    }
  }
}

async function showcasePrices(sessions, offerIdsBySeller) {
  // An active special price on one offer.
  {
    const session = sessions.get(SPECIAL.seller);
    const offerId = offerIdsBySeller.get(SPECIAL.seller).get(SPECIAL.sku);
    const prices = await session.ok('GET', `/pricing/seller/offers/${offerId}/prices`);
    const variantId = (await variantOrder(productIds.get(SPECIAL.product)))[SPECIAL.variant];
    const price = prices.variants.find((variant) => variant.variantId === variantId);
    if (price.special === null && price.heldSpecial === null) {
      await session.ok(
        'PUT',
        `/pricing/seller/offers/${offerId}/variants/${variantId}/special-price`,
        {
          amount: String(SPECIAL.amount),
          currency: 'AUD',
          endsAt: new Date(Date.now() + SPECIAL.days * 86_400_000)
            .toISOString()
            .replace(/\.\d+Z$/, 'Z'),
          expectedVersion: price.seriesVersion,
        },
      );
    }
  }
  // A regular price jump the platform holds for the admin.
  {
    const session = sessions.get(HELD.seller);
    const offerId = offerIdsBySeller.get(HELD.seller).get(HELD.sku);
    const prices = await session.ok('GET', `/pricing/seller/offers/${offerId}/prices`);
    const variantId = (await variantOrder(productIds.get(HELD.product)))[HELD.variant];
    const price = prices.variants.find((variant) => variant.variantId === variantId);
    if (
      price.held === null &&
      price.inForce !== null &&
      price.inForce.amount !== String(HELD.amount)
    ) {
      const written = await session.ok(
        'PUT',
        `/pricing/seller/offers/${offerId}/variants/${variantId}/regular-price`,
        { amount: String(HELD.amount), currency: 'AUD', expectedVersion: price.seriesVersion },
      );
      if (written.status !== 'pending-review') {
        log(
          `  note: the ${HELD.sku} jump was ${written.status}, not held (check pricing.jumpThreshold in the Market)`,
        );
      }
    }
  }
}

// 6. The buyer ----------------------------------------------------------------------------------
async function ensureBuyer() {
  const session = new Session('customer');
  const first = await session.request('POST', '/identity/customer/sign-in', BUYER);
  if (first.status === 200) return;
  const since = Date.now() - 2000;
  await session.ok('POST', '/identity/customer/sign-up', BUYER);
  const token = await mailLink(BUYER.email, /#(\S+)/, { since });
  await session.ok('POST', '/identity/customer/confirm-email', { token, password: BUYER.password });
}

function writeCredentials(state) {
  const lines = [
    'MondaPac local demo: sample logins (local machine only; created by scripts/demo-seed).',
    '',
    `Password for every account below: ${PASSWORD}`,
    '',
    `Admin panel   ${ORIGINS.admin}`,
    `  ${ADMIN.email}   (needs an authenticator code, see below)`,
    `  authenticator secret: ${state.admin.secret}`,
    `  or run:  node scripts/demo-seed/admin-code.mjs   to print the current 6-digit code`,
    '',
    `Seller panel  ${ORIGINS.seller}`,
    ...SELLERS.map(
      (seller) =>
        `  ${seller.email}   ${seller.storeName}${seller.leaveInReview ? ' (waiting for admin review, no offers)' : ''}`,
    ),
    '',
    `Buyer         ${ORIGINS.customer}   (the buyer site joins here later)`,
    `  ${BUYER.email}`,
    '',
    `Mail          ${MAILPIT}`,
  ];
  mkdirSync(LOCAL, { recursive: true });
  writeFileSync(CREDENTIALS_FILE, `${lines.join('\n')}\n`);
}

// -----------------------------------------------------------------------------------------------
await db.connect();
try {
  const state = readState();
  await prepare();
  const admin = await ensureAdmin(state);

  log('[3/8] Sellers');
  const sessions = new Map();
  for (const seller of SELLERS) {
    const session = await ensureSeller(admin, seller);
    if (session !== null) sessions.set(seller.key, session);
    log(`  ${seller.storeName}${session === null ? ' (left waiting for review)' : ''}`);
  }

  log('[4/8] Products');
  const categories = new Map(
    (
      await db.query('SELECT slug, id FROM catalog.platform_categories WHERE market_id = $1', [
        MARKET,
      ])
    ).rows.map((row) => [row.slug, row.id]),
  );
  let made = 0;
  for (const product of PRODUCTS) if (await ensureProduct(admin, product, categories)) made += 1;
  log(`  ${PRODUCTS.length} products (${made} new)`);

  log('[5/8] Offers, stock and prices');
  const offerIdsBySeller = new Map();
  const writes = new Map();
  for (const seller of SELLERS.filter((item) => !item.leaveInReview)) {
    const session = sessions.get(seller.key);
    const offerIds = await ensureOffers(admin, seller, session);
    offerIdsBySeller.set(seller.key, offerIds);
    await ensureStockAndPrices(seller, session, offerIds, writes);
    log(`  ${seller.storeName}: ${offerIds.size} offers`);
  }

  log('[6/8] A special price and a held price');
  await showcasePrices(sessions, offerIdsBySeller);

  log('[7/8] Buyer account');
  await ensureBuyer();

  log('[8/8] Writing the sample logins');
  writeCredentials(state);
  log(`Done. Logins: ${CREDENTIALS_FILE}`);
} finally {
  await db.end();
}
