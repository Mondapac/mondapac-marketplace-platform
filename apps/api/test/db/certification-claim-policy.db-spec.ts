import { randomUUID } from 'node:crypto';
import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id, IdGenerator, MarketContext } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { PrismaCatalogReferences } from '../../src/modules/catalog/infrastructure/prisma-catalog-references';
import type { PolicyRow } from '../../src/modules/certification/domain/claim-policy';
import { PrismaClaimPolicyRepository } from '../../src/modules/certification/infrastructure/prisma-claim-policy.repository';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// The claim basis policy of certification slice 13 on PostgreSQL, for both Market fixtures
// (docs/design/data/certification.md 3.14, 9.4): the repository over the tables of migration
// `certification_claim_policies` (one policy per type, revision numbers, the version guard, the
// row lock of lock-first), the CHECKs (one selector per row; M1: no manufacturer basis on a
// handling row), the insert-only triggers on revisions and rows, and catalog's
// `CatalogReferences` adapter (active platform categories of the Market only).

const T0 = Temporal.Instant.from('2026-10-18T00:00:00Z');
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const idGenerator: IdGenerator = { next: <K extends string>() => uuid7() as Id<K> };
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.each(TEST_MARKETS)('claim basis policy in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let persistence: Persistence;
  let sql: Client;
  let owner: Client;
  let policies: PrismaClaimPolicyRepository;
  let catalog: PrismaCatalogReferences;

  const inUnit = <T>(work: () => Promise<T>, m: MarketContext = market): Promise<T> =>
    persistence.unitOfWork
      .run(m, async () => ok(await work()))
      .then((result) => {
        if (!result.ok) throw new Error('unexpected refusal');
        return result.value;
      });

  beforeAll(async () => {
    persistence = createPersistence();
    sql = new Client({ connectionString: testDatabaseUrl() });
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await sql.connect();
    await owner.connect();
    policies = new PrismaClaimPolicyRepository(persistence.service, idGenerator);
    catalog = new PrismaCatalogReferences(persistence.unitOfWork, persistence.service);
  });
  afterAll(async () => {
    await sql.end();
    await owner.end();
    await persistence.close();
  });

  async function sqlState(client: Client, text: string, values: unknown[] = []) {
    try {
      await client.query(text, values);
      return null;
    } catch (error) {
      return (error as { code?: string }).code ?? 'unknown';
    }
  }

  /** A type with no revision: enough for the policy's foreign key. */
  async function type(m: MarketContext = market): Promise<Id<'CertificationType'>> {
    const typeId = uuid7() as Id<'CertificationType'>;
    await sql.query(
      `INSERT INTO certification.certification_types
         (id, market_id, tenant_id, code, verification_mode, status, published_revision_id, version, created_at)
       VALUES ($1, $2, $3, $4, 'THIRD_PARTY_DOCUMENT', 'active', NULL, 1, $5)`,
      [typeId, m.marketId, m.tenantId, `p${typeId.slice(-12)}`, T0.toString()],
    );
    return typeId;
  }

  async function category(status = 'active', m: MarketContext = market): Promise<Id<'Category'>> {
    const id = uuid7() as Id<'Category'>;
    await sql.query(
      `INSERT INTO catalog.platform_categories
         (id, market_id, tenant_id, parent_id, slug, status, created_by_kind, version, created_at)
       VALUES ($1, $2, $3, NULL, $4, $5, 'seed', 1, $6)`,
      [id, m.marketId, m.tenantId, `cp-${randomUUID().slice(0, 12)}`, status, T0.toString()],
    );
    return id;
  }

  const catRow = (categoryId: Id<'Category'>, basis: PolicyRow['basis']): PolicyRow => ({
    selector: { kind: 'platform-category', categoryId },
    basis,
  });

  async function policyWithRevision(rows: readonly PolicyRow[]) {
    const typeId = await type();
    const policyId = uuid7() as Id<'ClaimBasisPolicy'>;
    const revisionId = uuid7() as Id<'ClaimPolicyRevision'>;
    const author = uuid7() as Id<'Account'>;
    await inUnit(async () => {
      await policies.addPolicy(market, { id: policyId, typeId, createdAt: T0 });
      await policies.addRevision(market, {
        id: revisionId,
        policyId,
        rows,
        authorAccountId: author,
        changeReasonCiphertext: null,
        createdAt: T0,
      });
      await policies.publishRevision(market, policyId, revisionId, 1);
    });
    return { typeId, policyId, revisionId, author };
  }

  it('creates one policy per type, numbers revisions, stores rows canonically and publishes under the version', async () => {
    const food = await category();
    const drinks = await category();
    const rows: PolicyRow[] = [
      { selector: { kind: 'handling', handling: 'PREPARED' }, basis: 'NOT_APPLICABLE' },
      catRow(drinks, 'SELLER_OR_MANUFACTURER'),
      catRow(food, 'NOT_APPLICABLE'),
    ];
    const { typeId, policyId, revisionId } = await policyWithRevision(rows);
    expect(await inUnit(() => policies.policyOfType(market, typeId))).toEqual({
      id: policyId,
      typeId,
      publishedRevisionId: revisionId,
      version: 2,
    });
    const stored = await inUnit(() => policies.revision(market, revisionId));
    expect(stored).toMatchObject({ id: revisionId, policyId, revisionNo: 1 });
    expect(new Set(stored!.rows.map((r) => JSON.stringify(r)))).toEqual(
      new Set(rows.map((r) => JSON.stringify(r))),
    );

    // A second policy for the same type is a concurrent first save: stale.
    await expect(
      inUnit(() =>
        policies.addPolicy(market, {
          id: uuid7() as Id<'ClaimBasisPolicy'>,
          typeId,
          createdAt: T0,
        }),
      ),
    ).rejects.toBeInstanceOf(StaleAggregateError);
    // The next revision is number 2; the pointer moves only under the version read.
    const second = uuid7() as Id<'ClaimPolicyRevision'>;
    const no = await inUnit(() =>
      policies.addRevision(market, {
        id: second,
        policyId,
        rows: [],
        authorAccountId: uuid7() as Id<'Account'>,
        changeReasonCiphertext: `v1.${'A'.repeat(48)}`,
        createdAt: T0,
      }),
    );
    expect(no).toBe(2);
    await expect(
      inUnit(() => policies.publishRevision(market, policyId, second, 1)),
    ).rejects.toBeInstanceOf(StaleAggregateError);
    await expect(inUnit(() => policies.lockPolicy(market, policyId, 1))).rejects.toBeInstanceOf(
      StaleAggregateError,
    );
    await inUnit(() => policies.publishRevision(market, policyId, second, 2));
    expect(
      (await inUnit(() => policies.revisions(market, policyId, 50))).map((r) => [
        r.revisionNo,
        r.reasonGiven,
      ]),
    ).toEqual([
      [2, true],
      [1, false],
    ]);
    // Nothing of it is visible from the other Market.
    expect(await inUnit(() => policies.policyOfType(other, typeId), other)).toBeNull();
    expect(await inUnit(() => policies.revision(other, revisionId), other)).toBeNull();
  });

  it('makes a second decision wait behind the row lock of the first (lock first)', async () => {
    const { policyId, revisionId } = await policyWithRevision([]);
    const order: string[] = [];
    const first = inUnit(async () => {
      await policies.lockPolicy(market, policyId, 2);
      order.push('first-locked');
      await delay(300);
      await policies.publishRevision(market, policyId, revisionId, 2);
      order.push('first-done');
    });
    await delay(50);
    const second = inUnit(async () => {
      await policies.lockPolicy(market, policyId, 2);
      order.push('second-locked');
    });
    await first;
    // The second waited for the first to commit, then found the version moved.
    await expect(second).rejects.toBeInstanceOf(StaleAggregateError);
    expect(order).toEqual(['first-locked', 'first-done']);
  });

  it('makes the second of two concurrent first saves of a type stale (F2)', async () => {
    const typeId = await type();
    const first = inUnit(async () => {
      await policies.addPolicy(market, {
        id: uuid7() as Id<'ClaimBasisPolicy'>,
        typeId,
        createdAt: T0,
      });
      await delay(300);
    });
    await delay(50);
    // Waits on the unique (market_id, type_id) until the first commits, then clashes.
    const second = inUnit(() =>
      policies.addPolicy(market, {
        id: uuid7() as Id<'ClaimBasisPolicy'>,
        typeId,
        createdAt: T0,
      }),
    );
    await first;
    await expect(second).rejects.toBeInstanceOf(StaleAggregateError);
    const { rows } = await sql.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM certification.claim_basis_policies WHERE market_id = $1 AND type_id = $2`,
      [market.marketId, typeId],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('makes the second of two concurrent revisions with the same number stale (F2)', async () => {
    const { policyId } = await policyWithRevision([]);
    const revision = () => ({
      id: uuid7() as Id<'ClaimPolicyRevision'>,
      policyId,
      rows: [],
      authorAccountId: uuid7() as Id<'Account'>,
      changeReasonCiphertext: null,
      createdAt: T0,
    });
    const first = inUnit(async () => {
      expect(await policies.addRevision(market, revision())).toBe(2);
      await delay(300);
    });
    await delay(50);
    // Reads the same last number (the first has not committed), then waits on the unique.
    const second = inUnit(() => policies.addRevision(market, revision()));
    await first;
    await expect(second).rejects.toBeInstanceOf(StaleAggregateError);
  });

  it("refuses a pointer to another policy's revision (F4, 23503)", async () => {
    const one = await policyWithRevision([]);
    const two = await policyWithRevision([]);
    expect(
      await sqlState(
        owner,
        `UPDATE certification.claim_basis_policies SET published_revision_id = $1 WHERE id = $2`,
        [two.revisionId, one.policyId],
      ),
    ).toBe('23503');
  });

  it('refuses a row added to a published or proposed revision, accepts one on an open revision (Hassan L1)', async () => {
    const food = await category();
    const drinks = await category();
    const published = await policyWithRevision([catRow(food, 'NOT_APPLICABLE')]);
    const addRow = (revisionId: string, categoryId: string) =>
      sqlState(
        sql,
        `INSERT INTO certification.claim_policy_rows
           (id, market_id, tenant_id, revision_id, selector_kind, category_id, handling, basis)
         VALUES ($1, $2, $3, $4, 'platform-category', $5, NULL, 'SELLER_OR_MANUFACTURER')`,
        [uuid7(), market.marketId, market.tenantId, revisionId, categoryId],
      );
    expect(await addRow(published.revisionId, drinks)).toBe('23001');

    // A second revision, open until its proposal is inserted.
    const proposed = uuid7() as Id<'ClaimPolicyRevision'>;
    await inUnit(() =>
      policies.addRevision(market, {
        id: proposed,
        policyId: published.policyId,
        rows: [catRow(food, 'SELLER_REQUIRED')],
        authorAccountId: published.author,
        changeReasonCiphertext: null,
        createdAt: T0,
      }),
    );
    expect(await addRow(proposed, drinks)).toBeNull();
    await sql.query(
      `INSERT INTO certification.relaxation_proposals
         (id, market_id, tenant_id, subject_kind, subject_id, based_on_revision_id,
          proposed_revision_id, state, proposer_account_id, proposed_at, version, created_at)
       VALUES ($1, $2, $3, 'claim-policy-revision', $4, $5, $6, 'pending', $7, $8, 1, $8)`,
      [
        uuid7(),
        market.marketId,
        market.tenantId,
        published.policyId,
        published.revisionId,
        proposed,
        published.author,
        T0.toString(),
      ],
    );
    expect(await addRow(proposed, await category())).toBe('23001');
  });

  it('refuses the manufacturer basis on a handling row (M1) and a row with two selectors', async () => {
    const { policyId } = await policyWithRevision([]);
    const revisionId = uuid7();
    await sql.query(
      `INSERT INTO certification.claim_policy_revisions
         (id, market_id, tenant_id, policy_id, revision_no, change_reason_ciphertext, author_account_id, created_at)
       VALUES ($1, $2, $3, $4, 9, NULL, $5, $6)`,
      [revisionId, market.marketId, market.tenantId, policyId, uuid7(), T0.toString()],
    );
    const insertRow = (values: Record<string, unknown>) => {
      const row = {
        id: uuid7(),
        market_id: market.marketId,
        tenant_id: market.tenantId,
        revision_id: revisionId,
        ...values,
      };
      const columns = Object.keys(row);
      return sqlState(
        sql,
        `INSERT INTO certification.claim_policy_rows (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(row),
      );
    };
    expect(
      await insertRow({
        selector_kind: 'handling',
        category_id: null,
        handling: 'SEALED_ORIGINAL',
        basis: 'SELLER_OR_MANUFACTURER',
      }),
    ).toBe('23514');
    expect(
      await insertRow({
        selector_kind: 'handling',
        category_id: uuid7(),
        handling: 'SEALED_ORIGINAL',
        basis: 'SELLER_REQUIRED',
      }),
    ).toBe('23514');
    expect(
      await insertRow({
        selector_kind: 'handling',
        category_id: null,
        handling: 'SEALED_ORIGINAL',
        basis: 'SELLER_REQUIRED',
      }),
    ).toBeNull();
    // One row per selector in a revision.
    expect(
      await insertRow({
        selector_kind: 'handling',
        category_id: null,
        handling: 'SEALED_ORIGINAL',
        basis: 'NOT_APPLICABLE',
      }),
    ).toBe('23505');
  });

  it('keeps revisions and rows insert-only: 42501 for the application, 23001 for the owner', async () => {
    const food = await category();
    const { revisionId } = await policyWithRevision([catRow(food, 'NOT_APPLICABLE')]);
    for (const [table, key] of [
      ['claim_policy_revisions', 'id'],
      ['claim_policy_rows', 'revision_id'],
    ] as const) {
      expect(
        await sqlState(sql, `UPDATE certification.${table} SET market_id = market_id WHERE false`),
      ).toBe('42501');
      expect(await sqlState(sql, `DELETE FROM certification.${table} WHERE false`)).toBe('42501');
      expect(
        await sqlState(
          owner,
          `UPDATE certification.${table} SET market_id = market_id WHERE ${key} = $1`,
          [revisionId],
        ),
      ).toBe('23001');
      expect(
        await sqlState(owner, `DELETE FROM certification.${table} WHERE ${key} = $1`, [revisionId]),
      ).toBe('23001');
    }
    // The application moves only the root's pointer and version.
    expect(
      await sqlState(
        sql,
        `UPDATE certification.claim_basis_policies SET type_id = type_id WHERE false`,
      ),
    ).toBe('42501');
  });

  it("answers catalog's active platform categories of the Market only", async () => {
    const active = await category();
    const archived = await category('archived');
    const elsewhere = await category('active', other);
    const unknown = uuid7() as Id<'Category'>;
    const found = await catalog.platformCategoriesExist(market, [
      active,
      archived,
      elsewhere,
      unknown,
      active,
    ]);
    expect([...found]).toEqual([active]);
    expect(await catalog.platformCategoriesExist(market, [])).toEqual(new Set());
    await expect(
      catalog.platformCategoriesExist(
        market,
        Array.from({ length: 501 }, () => uuid7() as Id<'Category'>),
      ),
    ).rejects.toBeInstanceOf(RangeError);
  });
});
