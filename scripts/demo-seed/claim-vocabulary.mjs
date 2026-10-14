#!/usr/bin/env node
// Demo stand-in until the certification types can be created through the application: writes the
// claim vocabulary of the AU Market (halal, kosher, vegan and organic with their terms), because
// catalog refuses every product text, category name and attribute name while a Market has no
// published certification type (fail closed, certification design 8.1). Run it after
// `pnpm db:migrate` and before the worker starts, so the catalog seed jobs can run.
//
//   node scripts/demo-seed/claim-vocabulary.mjs
//
// Local PostgreSQL only (guard.mjs). Idempotent: a type that exists is left as it is.
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { ROOT, assertLocalDevelopment, loadDotEnv } from './guard.mjs';

loadDotEnv();
const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error('MIGRATION_DATABASE_URL is not set (copy .env.example to .env).');
  process.exit(1);
}
assertLocalDevelopment({ urls: { MIGRATION_DATABASE_URL: url } });

const { Client } = createRequire(resolve(ROOT, 'apps/api/package.json'))('pg');
const MARKET = process.env.DEMO_MARKET ?? 'AU';
const TENANT = 'mondapac';
const LOCALE = 'en-AU';
// A fixed system author: revisions need an account id and this stand-in has no account.
const AUTHOR = '00000000-0000-7000-8000-000000000001';

const TYPES = [
  {
    code: 'halal',
    mode: 'THIRD_PARTY_DOCUMENT',
    registry: true,
    document: true,
    expiry: true,
    icon: 'halal',
    name: 'Halal',
    description: 'Certified halal by an accepted certifying body.',
    terms: ['halal', 'halaal'],
  },
  {
    code: 'kosher',
    mode: 'THIRD_PARTY_DOCUMENT',
    registry: true,
    document: true,
    expiry: true,
    icon: 'kosher',
    name: 'Kosher',
    description: 'Certified kosher by an accepted certifying body.',
    terms: ['kosher'],
  },
  {
    code: 'vegan',
    mode: 'SELF_DECLARATION',
    registry: false,
    document: false,
    expiry: false,
    icon: 'vegan',
    name: 'Vegan',
    description: 'Declared vegan by the seller.',
    terms: ['vegan'],
  },
  {
    code: 'organic',
    mode: 'THIRD_PARTY_DOCUMENT',
    registry: true,
    document: true,
    expiry: true,
    icon: 'organic',
    name: 'Organic',
    description: 'Certified organic by an accepted certifying body.',
    terms: ['organic', 'certified organic'],
  },
];

const client = new Client({ connectionString: url });
await client.connect();
try {
  await client.query('BEGIN');
  let created = 0;
  for (const type of TYPES) {
    const exists = await client.query(
      'SELECT 1 FROM certification.certification_types WHERE market_id = $1 AND code = $2',
      [MARKET, type.code],
    );
    if (exists.rowCount > 0) continue;
    const typeId = randomUUID();
    const revisionId = randomUUID();
    await client.query(
      `INSERT INTO certification.certification_types
         (id, market_id, tenant_id, code, verification_mode, status, published_revision_id, version, created_at)
       VALUES ($1, $2, $3, $4, $5, 'active', NULL, 1, now())`,
      [typeId, MARKET, TENANT, type.code, type.mode],
    );
    await client.query(
      `INSERT INTO certification.certification_type_revisions
         (id, market_id, tenant_id, type_id, revision_no, verification_mode, requires_issuer_registry,
          requires_document, requires_expiry, default_basis, auto_approve_self_declaration,
          badge_icon_key, author_account_id, created_at)
       VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, 'SELLER_REQUIRED', false, $9, $10, now())`,
      [
        revisionId,
        MARKET,
        TENANT,
        typeId,
        type.mode,
        type.registry,
        type.document,
        type.expiry,
        type.icon,
        AUTHOR,
      ],
    );
    await client.query(
      `INSERT INTO certification.type_revision_texts
         (market_id, tenant_id, type_revision_id, locale, name, customer_description)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [MARKET, TENANT, revisionId, LOCALE, type.name, type.description],
    );
    for (const phrase of type.terms) {
      await client.query(
        `INSERT INTO certification.claim_terms (market_id, tenant_id, type_revision_id, locale, phrase)
         VALUES ($1, $2, $3, $4, $5)`,
        [MARKET, TENANT, revisionId, LOCALE, phrase],
      );
    }
    await client.query(
      'UPDATE certification.certification_types SET published_revision_id = $1 WHERE id = $2',
      [revisionId, typeId],
    );
    created += 1;
  }
  await client.query('COMMIT');
  console.log(
    `claim vocabulary: ${created} type(s) written, ${TYPES.length - created} already there`,
  );
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  await client.end();
}
