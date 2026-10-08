import { ok, uuidV7 } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { PrismaPublishedTypesReader } from '../../src/modules/certification/infrastructure/prisma-published-types.reader';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { certificationTestDatabaseUrl } from './test-database';

// The Prisma reader of the published types (data design 3.1 to 3.3, design 4.6), for both Market
// fixtures, on its own copy of the run database: it reads whole Markets, so no other file's types
// (drafts without a pointer or terms) may live there. Every type of the Market answers, in code
// order whatever the order of insertion; a type that cannot be read rejects the read.

const T0 = '2026-10-08T00:00:00Z';
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));

interface SavedType {
  readonly code: string;
  readonly status?: 'active' | 'inactive';
  /** locale -> phrases; a locale with no phrase still has its text. */
  readonly texts: Readonly<Record<string, readonly string[]>>;
  readonly published?: boolean;
}

// Two passes, in this order: the fault cases leave unreadable types behind in a Market, and no
// happy-path read may meet them.
for (const phase of ['happy', 'faults'] as const) {
  describe.each(TEST_MARKETS)(
    `certification published types reader (${phase}) in market %s (database)`,
    (code) => {
      const market = marketOf(code);
      const other = marketOf(otherMarketOf(code));
      let persistence: Persistence;
      let reader: PrismaPublishedTypesReader;
      let sql: Client;

      beforeAll(async () => {
        persistence = createPersistence({
          pause: () => Promise.resolve(),
          databaseUrl: certificationTestDatabaseUrl(),
        });
        reader = new PrismaPublishedTypesReader(persistence.service);
        sql = new Client({ connectionString: certificationTestDatabaseUrl() });
        await sql.connect();
      });
      afterAll(async () => {
        await sql.end();
        await persistence.close();
      });

      const read = <T>(work: () => Promise<T>, target: MarketContext = market): Promise<T> =>
        persistence.unitOfWork
          .run(target, async () => ok(await work()), { readOnly: true })
          .then((result) => {
            if (!result.ok) throw new Error('unit failed');
            return result.value;
          });

      /** Saves a type with its first revision, texts and terms in one transaction (3.20). */
      async function save(target: MarketContext, spec: SavedType): Promise<string> {
        const typeId = uuid7();
        const revisionId = uuid7();
        const scope = [target.marketId, target.tenantId];
        await sql.query('BEGIN');
        try {
          await sql.query(
            `INSERT INTO certification.certification_types
           (id, market_id, tenant_id, code, verification_mode, status, published_revision_id, version, created_at)
         VALUES ($1, $2, $3, $4, 'THIRD_PARTY_DOCUMENT', $5, NULL, 1, $6)`,
            [typeId, ...scope, spec.code, spec.status ?? 'active', T0],
          );
          await sql.query(
            `INSERT INTO certification.certification_type_revisions
           (id, market_id, tenant_id, type_id, revision_no, verification_mode, requires_issuer_registry,
            requires_document, requires_expiry, default_basis, auto_approve_self_declaration,
            badge_icon_key, author_account_id, created_at)
         VALUES ($1, $2, $3, $4, 1, 'THIRD_PARTY_DOCUMENT', true, true, true, 'SELLER_REQUIRED', false,
                 'halal', $5, $6)`,
            [revisionId, ...scope, typeId, uuid7(), T0],
          );
          for (const [locale, phrases] of Object.entries(spec.texts)) {
            await sql.query(
              `INSERT INTO certification.type_revision_texts
             (market_id, tenant_id, type_revision_id, locale, name, customer_description)
           VALUES ($1, $2, $3, $4, $5, $6)`,
              [
                ...scope,
                revisionId,
                locale,
                `Name ${spec.code} ${locale}`,
                `Description ${spec.code}`,
              ],
            );
            for (const phrase of phrases) {
              await sql.query(
                `INSERT INTO certification.claim_terms (market_id, tenant_id, type_revision_id, locale, phrase)
             VALUES ($1, $2, $3, $4, $5)`,
                [...scope, revisionId, locale, phrase],
              );
            }
          }
          if (spec.published !== false) {
            await sql.query(
              `UPDATE certification.certification_types SET published_revision_id = $1 WHERE id = $2`,
              [revisionId, typeId],
            );
          }
          await sql.query('COMMIT');
        } catch (error) {
          await sql.query('ROLLBACK');
          throw error;
        }
        return revisionId;
      }

      if (phase === 'happy')
        it('answers one entry per type, active or inactive, in code order whatever the insertion order', async () => {
          // Inserted out of code order on purpose.
          const zRevision = await save(market, {
            code: 'zz-last',
            status: 'inactive',
            texts: { en: ['zed', 'zeta'], ar: ['زد'] },
          });
          await save(market, { code: 'aa-first', texts: { en: ['bravo', 'alpha'] } });
          const mid = await save(market, {
            code: 'mm-middle',
            texts: { en: ['mike'], fr: ['mikel'] },
          });
          const own = `only-in-${code.toLowerCase()}`;
          await save(market, { code: own, texts: { en: [own] } });
          // Types of the other Market never answer here.
          await save(other, {
            code: `elsewhere-${code.toLowerCase()}`,
            texts: { en: ['elsewhere'] },
          });

          // The other describe saves its 'elsewhere-*' type into this Market, by design; set it aside.
          const mine = <T extends { typeCode?: string; code?: string }>(rows: readonly T[]): T[] =>
            rows.filter((row) => !(row.typeCode ?? row.code ?? '').startsWith('elsewhere-'));
          const vocabulary = mine(await read(() => reader.claimVocabulary(market)));
          expect(vocabulary).toEqual([
            { typeCode: 'aa-first', terms: ['alpha', 'bravo'] },
            { typeCode: 'mm-middle', terms: ['mike', 'mikel'] },
            { typeCode: own, terms: [own] },
            { typeCode: 'zz-last', terms: ['zed', 'zeta', 'زد'] },
          ]);

          const all = mine(await read(() => reader.types(market, {})));
          expect(all.map((t) => t.code)).toEqual(['aa-first', 'mm-middle', own, 'zz-last']);
          expect(all.map((t) => t.status)).toEqual(['active', 'active', 'active', 'inactive']);
          const middle = all[1]!;
          expect(middle).toEqual({
            code: 'mm-middle',
            status: 'active',
            publishedRevisionId: mid,
            verificationMode: 'THIRD_PARTY_DOCUMENT',
            requiresIssuerRegistry: true,
            requiresDocument: true,
            requiresExpiry: true,
            defaultBasis: 'SELLER_REQUIRED',
            autoApproveSelfDeclaration: false,
            badgeIconKey: 'halal',
            locales: {
              en: { name: 'Name mm-middle en', customerDescription: 'Description mm-middle' },
              fr: { name: 'Name mm-middle fr', customerDescription: 'Description mm-middle' },
            },
          });
          expect(all[3]!.publishedRevisionId).toBe(zRevision);
          expect(Object.keys(all[3]!.locales)).toEqual(['ar', 'en']);

          expect(
            mine(await read(() => reader.types(market, { status: 'inactive' }))).map((t) => t.code),
          ).toEqual(['zz-last']);
          expect(
            mine(await read(() => reader.types(market, { status: 'active' }))).map((t) => t.code),
          ).toEqual(['aa-first', 'mm-middle', own]);

          // The other Market answers its own types only.
          const elsewhere = (await read(() => reader.types(other, {}), other)).map((t) => t.code);
          expect(elsewhere).toContain(`elsewhere-${code.toLowerCase()}`);
          expect(elsewhere).not.toContain(own);
        });

      if (phase === 'faults') {
        it('rejects the vocabulary, not the type list, when a type has no claim term (never drops the type)', async () => {
          await save(market, { code: 'no-terms', texts: { en: [] } });
          await expect(read(() => reader.claimVocabulary(market))).rejects.toThrow(
            /no-terms.*no claim term/,
          );
          const all = await read(() => reader.types(market, {}));
          expect(all.map((t) => t.code)).toContain('no-terms');
        });

        it('rejects both reads when a type has no published revision (never drops the type)', async () => {
          await save(market, {
            code: 'unpublished',
            texts: { en: ['unpublished'] },
            published: false,
          });
          await expect(read(() => reader.claimVocabulary(market))).rejects.toThrow(
            /unpublished.*no readable published revision/,
          );
          await expect(read(() => reader.types(market, {}))).rejects.toThrow(
            /unpublished.*no readable published revision/,
          );
          // The filter hides the fault only when it excludes the type by its own status.
          await expect(read(() => reader.types(market, { status: 'active' }))).rejects.toThrow();
        });
      }
    },
  );
}
