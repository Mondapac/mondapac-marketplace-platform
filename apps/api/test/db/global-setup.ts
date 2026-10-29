import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { applicationDatabaseUrl, migrationDatabaseUrl, REPO_ROOT } from './test-database';

/**
 * Creates a fresh database for this run as the migration role and applies all migrations to
 * it. Tests never clean tables (the audit log is append-only by design); the whole database
 * is dropped in global teardown instead. Two URLs of it are exported: the application login
 * and the owner (docs/design/data/platform.md 10.4).
 */
export default async function globalSetup(): Promise<void> {
  const name = `mondapac_test_${randomBytes(6).toString('hex')}`;
  const ownerUrl = new URL(migrationDatabaseUrl());
  ownerUrl.pathname = `/${name}`;
  const applicationUrl = new URL(applicationDatabaseUrl());
  applicationUrl.pathname = `/${name}`;

  const admin = new Client({ connectionString: migrationDatabaseUrl() });
  await admin.connect();
  try {
    // A migration that needs a superuser must fail here, not in production (10.1).
    const { rows } = await admin.query<{ rolsuper: boolean }>(
      'SELECT rolsuper FROM pg_roles WHERE rolname = current_user',
    );
    if (rows[0]?.rolsuper !== false) {
      throw new Error(
        'MIGRATION_DATABASE_URL connects as a superuser; it must name the migration role ' +
          '(see .env.example and scripts/db/bootstrap-dev.sql).',
      );
    }
    await admin.query(`CREATE DATABASE "${name}"`);
    // Recorded at once, so that the teardown drops it even if a statement below fails.
    process.env.TEST_DATABASE_NAME = name;
    // A new database gets the default ACL, not its template's (10.7).
    await admin.query(`REVOKE ALL ON DATABASE "${name}" FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE "${name}" TO "mondapac_app"`);
  } finally {
    await admin.end();
  }

  process.env.TEST_DATABASE_URL = applicationUrl.toString();
  process.env.TEST_OWNER_DATABASE_URL = ownerUrl.toString();

  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: REPO_ROOT,
    env: { ...process.env, MIGRATION_DATABASE_URL: ownerUrl.toString() },
    stdio: ['ignore', 'ignore', 'inherit'],
    shell: process.platform === 'win32',
  });

  await createCopy(name, 'LOCKING');
  await createCopy(name, 'RELAY');
  await createCopy(name, 'DELIVERY');
  await createCopy(name, 'MAIL');
  await createCopy(name, 'SELLER');
  await createCopy(name, 'SELLER_FILES');
  await createCopy(name, 'SELLER_SUBMIT');
  await createCopy(name, 'PASSWORD');
  await createCopy(name, 'INVENTORY');
  await createCopy(name, 'AUDIT');
  await createCopy(name, 'ADMIN_TEAM');
  await createCopy(name, 'CERTIFICATION');
  await createCopy(name, 'CATALOG_CLAIMS');
  await createCopy(name, 'CLAIM_FACTS');
  await createCopy(name, 'CERT_SEED');
  await createCopy(name, 'CATALOG_REVISIONS');
  await createCopy(name, 'CATALOG_ATTRIBUTES');
  await createCopy(name, 'PRICING_CONSTRAINTS');
  await createCopy(name, 'CERT_CLAIMS_CORE');
  await createCopy(name, 'STORE_PROFILE');
  await createCopy(name, 'CERTIFIED_CATEGORIES');
  await createCopy(name, 'WALLET_SWITCH');
  await createCopy(name, 'WALLET_CREDIT');
  await createCopy(name, 'ORDERING_REFUNDS');
  await createCopy(name, 'PAYOUT_HOLDS');
  await createCopy(name, 'DISPUTES');
  await createCopy(name, 'SELLERS_LIST');
  await createCopy(name, 'ORDERING_ORDERS');
}

/**
 * A copy of the migrated run database for one spec file that must not meet the others:
 * - `locking`: unit-of-work.db-spec.ts takes table locks and changes triggers on
 *   `platform.audit_log`, so no other file meets those locks, whatever the role's lock_timeout;
 * - `relay`: relay.db-spec.ts claims and marks every unpublished outbox row and starts a worker,
 *   so it never publishes a row another file wrote and still reads as unpublished;
 * - `delivery`: event-delivery.db-spec.ts relays and dispatches every pending row of a Market
 *   with test subscriptions, so it never claims a row another file wrote;
 * - `mail`: email-verification.db-spec.ts relays and dispatches identity's own events to its
 *   mail handlers, for the same reason;
 * - `seller`: seller-account.db-spec.ts relays and dispatches identity's seller events to the
 *   link and welcome mail handlers, for the same reason;
 * - `seller_files`: sellers-files.db-spec.ts relays and dispatches identity's seller events to
 *   `sellers.create-file`, for the same reason;
 * - `seller_submit`: sellers-submit.db-spec.ts relays and dispatches sellers' own submission events
 *   to `sellers.after-submission` (and identity's seller events to `sellers.create-file`), for
 *   the same reason;
 * - `password`: password-reset.db-spec.ts relays and dispatches identity's reset and change
 *   events to their mail handlers, for the same reason;
 * - `inventory`: inventory-sources.db-spec.ts relays and dispatches seller-registered events to
 *   `inventory.ensure-seller-inventory`, for the same reason;
 * - `audit`: platform-audit-chain.db-spec.ts seals every row of a Market, tampers with the chain
 *   as the owner and resets it between cases, so no other file's audit rows live there;
 * - `admin_team`: admin-roles.db-spec.ts counts every active Platform Administrator of a Market
 *   (HF8), so no other file's admin accounts live there;
 * - `certification`: certification-published-types-reader.db-spec.ts reads every type of a
 *   Market, so no other file's types (drafts without terms or pointer) live there;
 * - `claim_facts`: certification-claim-facts-reader.db-spec.ts seeds types without a published
 *   revision (a fault for any read that asks for them), so it keeps its own copy;
 * - `catalog_revisions`, `catalog_attributes`, `pricing_constraints`: the spec of that name
 *   probes the owner's TRUNCATE ... CASCADE, which takes ACCESS EXCLUSIVE on every table that
 *   references the probed one, transitively (for catalog.product_revisions and
 *   catalog.attribute_family_revisions: products, variants, offers, working copies and more), one
 *   by one before the refusing trigger runs; holding some while waiting for the next deadlocked
 *   (40P01) the writers of other files, so each of these files keeps its own copy;
 *   `cert_seed`: certification-seed.db-spec.ts runs the type seed and reads whole Markets (the
 *   vocabulary), so no other file's types live there.
 * - `cert_claims_core`: certification-claims-core.db-spec.ts (with the types registry suite it
 *   runs) probes the owner's TRUNCATE ... CASCADE on the insert-only certification tables; from
 *   certification_type_revisions that reaches every table under certification_types (issuers,
 *   seller certificates, uploaded documents, issuer requests and their links), so it deadlocked
 *   (40P01) the certification writers of other files and keeps its own copy.
 * - `store_profile`: sellers-store-profile-http.db-spec.ts runs the whole application over HTTP, seeds
 *   a published claim-term vocabulary per Market and relays and dispatches sellers' and identity's
 *   events, so no other file's vocabulary or outbox rows live there.
 * - `certified_categories`: certification-certified-categories.db-spec.ts reads the policy rows of
 *   whole Markets, so no other file's policies live there;
 * - `wallet_switch`: admin-step-up.db-spec.ts moves each Market's wallet switch through the admin
 *   step-up, so the switch of wallet-ledger.db-spec.ts never changes under it.
 * - `wallet_credit`: wallet-admin-credit.db-spec.ts moves each Market's wallet switch (active,
 *   paused) and counts each admin's day of admin credit, so no other file's switch or credit
 *   lives there.
 * - `ordering_refunds`: ordering-refunds.db-spec.ts writes many paid orders and runs the
 *   Market-wide ledger steps (`RecordLedger`, `RecordRefundLedger`, `SettleRefunds`), so it never
 *   records another file's queued seller order or refund, and never moves the Market-wide order
 *   counts another file reads (ordering-order-repository.db-spec.ts compares them).
 * - `payout_holds`: commission-payouts-terms-holds.db-spec.ts relays and dispatches identity's
 *   seller-access events to the commission-payouts handlers, and the relay and the dispatcher claim
 *   every due row of a Market.
 * - `sellers_list`: sellers-list.db-spec.ts compares the tab counts of a whole Market before and
 *   after making its own seller files, so no other file makes or submits a seller file in that
 *   Market between the two reads.
 * - `ordering_orders`: ordering-order-repository.db-spec.ts compares the order counts of whole
 *   Markets (its own and the other fixture) before and after inserting its own orders, and other
 *   files (pickup codes, paid outbox, offer pairs, storefront reads) insert and confirm orders in
 *   both Markets in parallel, so no other file's order lives there.
 * Copied before any test connects, since a template must have no other session.
 */
async function createCopy(
  template: string,
  kind:
    | 'LOCKING'
    | 'RELAY'
    | 'DELIVERY'
    | 'MAIL'
    | 'SELLER'
    | 'SELLER_FILES'
    | 'SELLER_SUBMIT'
    | 'PASSWORD'
    | 'INVENTORY'
    | 'AUDIT'
    | 'ADMIN_TEAM'
    | 'CERTIFICATION'
    | 'CATALOG_CLAIMS'
    | 'CLAIM_FACTS'
    | 'CERT_SEED'
    | 'CATALOG_REVISIONS'
    | 'CATALOG_ATTRIBUTES'
    | 'PRICING_CONSTRAINTS'
    | 'CERT_CLAIMS_CORE'
    | 'STORE_PROFILE'
    | 'CERTIFIED_CATEGORIES'
    | 'WALLET_SWITCH'
    | 'WALLET_CREDIT'
    | 'ORDERING_REFUNDS'
    | 'PAYOUT_HOLDS'
    | 'DISPUTES'
    | 'SELLERS_LIST'
    | 'ORDERING_ORDERS',
): Promise<void> {
  const name = `${template}_${kind.toLowerCase()}`;
  const admin = new Client({ connectionString: migrationDatabaseUrl() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
    // Recorded at once, so that the teardown drops the copy even if a statement below fails.
    process.env[`TEST_${kind}_DATABASE_NAME`] = name;
    await admin.query(`REVOKE ALL ON DATABASE "${name}" FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE "${name}" TO "mondapac_app"`);
  } finally {
    await admin.end();
  }
  const ownerUrl = new URL(migrationDatabaseUrl());
  ownerUrl.pathname = `/${name}`;
  const applicationUrl = new URL(applicationDatabaseUrl());
  applicationUrl.pathname = `/${name}`;
  process.env[`TEST_${kind}_DATABASE_URL`] = applicationUrl.toString();
  process.env[`TEST_${kind}_OWNER_DATABASE_URL`] = ownerUrl.toString();
}
