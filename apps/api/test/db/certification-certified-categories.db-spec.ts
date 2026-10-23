import { uuidV7 } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { PrismaCertifiedCategoriesReader } from '../../src/modules/certification/infrastructure/prisma-certified-categories.reader';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import {
  certifiedCategoriesOwnerTestDatabaseUrl,
  certifiedCategoriesTestDatabaseUrl,
} from './test-database';

// The reader behind `certifiedCategoryIds` (personalization 1d-1) on both Market fixtures, as the
// application login, on its own copy of the run database (it reads whole Markets of policy rows):
// the categories named by the PUBLISHED revision of a policy with a basis other than
// NOT_APPLICABLE, for any type, active or inactive; never a handling row, an unpublished
// revision, an older revision, another Market's row, and each category once, sorted.

const T0 = '2026-10-21T00:00:00Z';
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));

interface Row {
  readonly category?: string;
  readonly handling?: string;
  readonly basis: string;
}

describe.each(TEST_MARKETS)('certified categories reader in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let persistence: Persistence;
  let reader: PrismaCertifiedCategoriesReader;
  let owner: Client;

  beforeAll(async () => {
    persistence = createPersistence({
      pause: () => Promise.resolve(),
      databaseUrl: certifiedCategoriesTestDatabaseUrl(),
    });
    reader = new PrismaCertifiedCategoriesReader(persistence.unitOfWork, persistence.service);
    owner = new Client({ connectionString: certifiedCategoriesOwnerTestDatabaseUrl() });
    await owner.connect();
  });
  afterAll(async () => {
    await owner.end();
    await persistence.close();
  });

  const scope = (target: MarketContext) => [target.marketId, target.tenantId];

  async function seedType(target: MarketContext, status: 'active' | 'inactive'): Promise<string> {
    const typeId = uuid7();
    await owner.query(
      `INSERT INTO certification.certification_types
         (id, market_id, tenant_id, code, verification_mode, status, published_revision_id, version, created_at)
       VALUES ($1, $2, $3, $4, 'THIRD_PARTY_DOCUMENT', $5, NULL, 1, $6)`,
      [typeId, ...scope(target), `t${typeId.slice(-12)}`, status, T0],
    );
    return typeId;
  }

  /** A policy of the type with one revision per row set; `published` is the index of the live one. */
  async function seedPolicy(
    target: MarketContext,
    typeId: string,
    revisions: readonly (readonly Row[])[],
    published: number | null,
  ): Promise<void> {
    const policyId = uuid7();
    await owner.query(
      `INSERT INTO certification.claim_basis_policies
         (id, market_id, tenant_id, type_id, published_revision_id, version, created_at)
       VALUES ($1, $2, $3, $4, NULL, 1, $5)`,
      [policyId, ...scope(target), typeId, T0],
    );
    const ids: string[] = [];
    for (const [index, rows] of revisions.entries()) {
      const revisionId = uuid7();
      ids.push(revisionId);
      await owner.query(
        `INSERT INTO certification.claim_policy_revisions
           (id, market_id, tenant_id, policy_id, revision_no, author_account_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [revisionId, ...scope(target), policyId, index + 1, uuid7(), T0],
      );
      for (const row of rows) {
        await owner.query(
          `INSERT INTO certification.claim_policy_rows
             (id, market_id, tenant_id, revision_id, selector_kind, category_id, handling, basis)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            uuid7(),
            ...scope(target),
            revisionId,
            row.category === undefined ? 'handling' : 'platform-category',
            row.category ?? null,
            row.handling ?? null,
            row.basis,
          ],
        );
      }
    }
    if (published !== null) {
      await owner.query(
        `UPDATE certification.claim_basis_policies SET published_revision_id = $1 WHERE id = $2`,
        [ids[published], policyId],
      );
    }
  }

  it('answers the categories of the published revisions with a certification basis, once, sorted', async () => {
    const [a, b, c, d, e, f, g] = [1, 2, 3, 4, 5, 6, 7].map(() => uuid7());
    const active = await seedType(market, 'active');
    const inactive = await seedType(market, 'inactive');
    const third = await seedType(market, 'active');
    const foreign = await seedType(other, 'active');
    // An active type: two certified categories, one that needs none, a handling row.
    await seedPolicy(
      market,
      active,
      [
        [
          { category: a, basis: 'SELLER_REQUIRED' },
          { category: b, basis: 'SELLER_OR_MANUFACTURER' },
          { category: c, basis: 'NOT_APPLICABLE' },
          { handling: 'SEALED_ORIGINAL', basis: 'SELLER_REQUIRED' },
        ],
      ],
      0,
    );
    // An inactive type counts too; a category named by two types is answered once.
    await seedPolicy(
      market,
      inactive,
      [
        [
          { category: d, basis: 'SELLER_REQUIRED' },
          { category: a, basis: 'SELLER_REQUIRED' },
        ],
      ],
      0,
    );
    // Only the published revision counts: the old one (e) and a pending one (f) do not.
    await seedPolicy(
      market,
      third,
      [
        [{ category: e, basis: 'SELLER_REQUIRED' }],
        [{ category: g, basis: 'SELLER_REQUIRED' }],
        [{ category: f, basis: 'SELLER_REQUIRED' }],
      ],
      1,
    );
    // Another Market's policy never answers here.
    const foreignCategory = uuid7();
    await seedPolicy(
      other,
      foreign,
      [[{ category: foreignCategory, basis: 'SELLER_REQUIRED' }]],
      0,
    );

    // The two Market fixtures share one database and run one after the other: look only at the
    // categories seeded here (an earlier fixture left its own foreign row behind).
    const mine = new Set([a, b, c, d, e, f, g, foreignCategory]);
    const answer = (await reader.categoryIds(market)).filter((id) => mine.has(id));
    const elsewhere = (await reader.categoryIds(other)).filter((id) => mine.has(id));

    expect([...answer]).toEqual([a, b, d, g].sort());
    expect(elsewhere).toEqual([foreignCategory]);
  });
});
