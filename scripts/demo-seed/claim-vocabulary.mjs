#!/usr/bin/env node
// Demo stand-in until the certification types can be created through the application: writes the
// claim vocabulary of the AU Market (halal, kosher, vegan and organic with their terms), because
// catalog refuses every product text, category name and attribute name while a Market has no
// published certification type (fail closed, certification design 8.1). Run it after
// `pnpm db:migrate`; the operational test data loader (scripts/ops-data) runs it once the worker's
// certification seed job has written the codes of config/certification-seed.
//
//   node scripts/demo-seed/claim-vocabulary.mjs
//
// Local PostgreSQL only (guard.mjs). Idempotent: a type that exists is left as it is, also one
// that the worker's seed job writes while this runs.
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { ROOT, assertDatabaseMarker, assertLocalDevelopment, loadDotEnv } from './guard.mjs';

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

/**
 * A UUIDv7 (RFC 9562): the API accepts only version 7 ids (shared kernel parseId), so a v4 id
 * written here would be refused wherever an admin page sends it back (an issuer's typeId).
 */
function uuidv7() {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Earlier versions of this script wrote UUIDv4 type ids, which the API refuses (the type page of
 * the admin Inbox then says "This type could not be loaded"). A type that is already there with
 * such an id gets a v7 id here, with everything that points at it. Foreign keys are found in the
 * catalog, so a table added later is covered; the constraints are not deferrable, so the new type
 * row is added first (under a temporary code), the pointers are moved, then the old row goes.
 * Only a pristine seed is moved: a type that issuers, certificates, documents or product
 * certificates already use stops the run with nothing changed (those tables reference each other
 * by keys that carry the type id, so they cannot move one at a time); reset the test database
 * instead. The repair also switches an append-only guard off, so it runs only on a database that
 * carries the operational test marker.
 */
async function repairTypeIds(db) {
  const old = await db.query(
    'SELECT id, code FROM certification.certification_types WHERE market_id = $1',
    [MARKET],
  );
  let repaired = 0;
  const stale = old.rows.filter((r) => !V7.test(r.id));
  if (stale.length > 0) await assertDatabaseMarker(db);
  for (const row of stale) {
    const newId = uuidv7();
    await db.query(
      `INSERT INTO certification.certification_types
         (id, market_id, tenant_id, code, verification_mode, status, published_revision_id, version, created_at)
       SELECT $1::uuid, market_id, tenant_id, 'tmp-' || substr($1::text, 1, 8), verification_mode, status, NULL, version, created_at
         FROM certification.certification_types WHERE id = $2`,
      [newId, row.id],
    );
    // The old row stops pointing at its published revision, so the revisions can move.
    const published = await db.query(
      'SELECT published_revision_id AS revision FROM certification.certification_types WHERE id = $1',
      [row.id],
    );
    const revisionId = published.rows[0].revision;
    await db.query(
      'UPDATE certification.certification_types SET published_revision_id = NULL WHERE id = $1',
      [row.id],
    );
    // Every column that references certification_types(id): the foreign keys of the catalog.
    const pointers = await db.query(
      `SELECT DISTINCT ns.nspname AS schema, cl.relname AS tbl, att.attname AS col
         FROM pg_constraint con
         JOIN pg_class cl ON cl.oid = con.conrelid
         JOIN pg_namespace ns ON ns.oid = cl.relnamespace
         CROSS JOIN LATERAL unnest(con.conkey, con.confkey) AS k(child, parent)
         JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.child
         JOIN pg_attribute pat ON pat.attrelid = con.confrelid AND pat.attnum = k.parent
        WHERE con.contype = 'f'
          AND con.confrelid = 'certification.certification_types'::regclass
          AND pat.attname = 'id'`,
    );
    for (const { schema, tbl, col } of pointers.rows) {
      if (tbl === 'certification_type_revisions' || tbl === 'claim_basis_policies') continue;
      const used = await db.query(
        `SELECT count(*)::int AS n FROM ${quote(schema)}.${quote(tbl)} WHERE ${quote(col)} = $1`,
        [row.id],
      );
      if (used.rows[0].n > 0) {
        throw new Error(
          `${schema}.${tbl} already has ${used.rows[0].n} row(s) for type ${row.code}; the id can only be repaired on a pristine seed. Reset the operational test database and load again. Nothing was changed.`,
        );
      }
    }
    for (const { schema, tbl, col } of pointers.rows.sort((a, b) =>
      `${a.schema}.${a.tbl}`.localeCompare(`${b.schema}.${b.tbl}`),
    )) {
      // Revisions are append-only; the owner of the table may switch that guard off for this one
      // statement (it comes back on in the same transaction, which a failure rolls back).
      const guarded = tbl === 'certification_type_revisions';
      if (guarded) {
        await db.query(
          `ALTER TABLE ${quote(schema)}.${quote(tbl)} DISABLE TRIGGER certification_type_revisions_no_update_delete`,
        );
      }
      await db.query(
        `UPDATE ${quote(schema)}.${quote(tbl)} SET ${quote(col)} = $1 WHERE ${quote(col)} = $2`,
        [newId, row.id],
      );
      if (guarded) {
        await db.query(
          `ALTER TABLE ${quote(schema)}.${quote(tbl)} ENABLE TRIGGER certification_type_revisions_no_update_delete`,
        );
      }
    }
    // A column named type_id without a foreign key would be left pointing at nothing.
    const loose = await db.query(
      `SELECT table_schema, table_name FROM information_schema.columns
        WHERE column_name = 'type_id' AND data_type = 'uuid' AND table_schema NOT IN ('pg_catalog', 'information_schema')`,
    );
    for (const { table_schema: schema, table_name: tbl } of loose.rows) {
      const left = await db.query(
        `SELECT count(*)::int AS n FROM ${quote(schema)}.${quote(tbl)} WHERE type_id = $1`,
        [row.id],
      );
      if (left.rows[0].n > 0) {
        throw new Error(
          `${schema}.${tbl} still holds the old id of type ${row.code} (${row.id}); nothing was changed`,
        );
      }
    }
    await db.query('DELETE FROM certification.certification_types WHERE id = $1', [row.id]);
    await db.query(
      'UPDATE certification.certification_types SET code = $1, published_revision_id = $2 WHERE id = $3',
      [row.code, revisionId, newId],
    );
    console.log(`claim vocabulary: type ${row.code} ${row.id} -> ${newId}`);
    repaired += 1;
  }
  const left = await db.query(
    'SELECT code FROM certification.certification_types WHERE market_id = $1 AND id::text !~ $2',
    [MARKET, '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'],
  );
  if (left.rowCount > 0) throw new Error('a certification type still has a non-v7 id');
  return repaired;
}

function quote(name) {
  return `"${name.replaceAll('"', '""')}"`;
}

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
  const repaired = await repairTypeIds(client);
  let created = 0;
  for (const type of TYPES) {
    const typeId = uuidv7();
    const revisionId = uuidv7();
    // One statement claims the code: the worker's certification.seed-certification-types job
    // (runAtStart) writes the same codes of config/certification-seed at the same moment, so a
    // SELECT first and an INSERT after would race it (duplicate (market_id, code)). ON CONFLICT
    // waits for a concurrent insert of the code to commit and then writes nothing; the type that
    // is there is left as it is.
    const claimed = await client.query(
      `INSERT INTO certification.certification_types
         (id, market_id, tenant_id, code, verification_mode, status, published_revision_id, version, created_at)
       VALUES ($1, $2, $3, $4, $5, 'active', NULL, 1, now())
       ON CONFLICT (market_id, code) DO NOTHING
       RETURNING id`,
      [typeId, MARKET, TENANT, type.code, type.mode],
    );
    if (claimed.rowCount === 0) continue;
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
    `claim vocabulary: ${created} type(s) written, ${TYPES.length - created} already there` +
      (repaired > 0 ? `, ${repaired} type id(s) changed to UUIDv7` : ''),
  );
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  await client.end();
}
