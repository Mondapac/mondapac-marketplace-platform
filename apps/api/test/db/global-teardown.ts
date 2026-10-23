import { Client } from 'pg';
import { migrationDatabaseUrl } from './test-database';

export default async function globalTeardown(): Promise<void> {
  const names = [
    process.env.TEST_LOCKING_DATABASE_NAME,
    process.env.TEST_RELAY_DATABASE_NAME,
    process.env.TEST_DELIVERY_DATABASE_NAME,
    process.env.TEST_MAIL_DATABASE_NAME,
    process.env.TEST_SELLER_DATABASE_NAME,
    process.env.TEST_SELLER_FILES_DATABASE_NAME,
    process.env.TEST_SELLER_SUBMIT_DATABASE_NAME,
    process.env.TEST_PASSWORD_DATABASE_NAME,
    process.env.TEST_INVENTORY_DATABASE_NAME,
    process.env.TEST_AUDIT_DATABASE_NAME,
    process.env.TEST_ADMIN_TEAM_DATABASE_NAME,
    process.env.TEST_CERTIFICATION_DATABASE_NAME,
    process.env.TEST_CATALOG_CLAIMS_DATABASE_NAME,
    process.env.TEST_CLAIM_FACTS_DATABASE_NAME,
    process.env.TEST_CERT_SEED_DATABASE_NAME,
    process.env.TEST_CATALOG_REVISIONS_DATABASE_NAME,
    process.env.TEST_CATALOG_ATTRIBUTES_DATABASE_NAME,
    process.env.TEST_PRICING_CONSTRAINTS_DATABASE_NAME,
    process.env.TEST_CERT_CLAIMS_CORE_DATABASE_NAME,
    process.env.TEST_CERTIFIED_CATEGORIES_DATABASE_NAME,
    process.env.TEST_DATABASE_NAME,
  ].filter((name): name is string => name !== undefined && name !== '');
  if (names.length === 0) return;

  const admin = new Client({ connectionString: migrationDatabaseUrl() });
  await admin.connect();
  try {
    for (const name of names) {
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
  } finally {
    await admin.end();
  }
}
