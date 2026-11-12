import { Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { PrismaSellerCultureRepository } from '../../src/modules/sellers/infrastructure/prisma-seller-culture.repository';
import {
  approveAtSignup,
  decideMembership,
  demoteMembership,
  requestMembership,
} from '../../src/modules/sellers/domain/seller-culture';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { sqlState } from './sql-state';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// A seller's culture memberships (multi-culture package 2; ADR-0047 decision 3, ADR-0048) on
// PostgreSQL, for both Market fixtures: the CHECKs of `sellers.seller_cultures`, the one row per
// seller and culture, the repository (request, decision, request again, Market isolation, the
// roster of sellers with no culture), the races of a double request and a double decision, and the
// least-privilege grants as the application role.

const T0 = Temporal.Instant.from('2026-11-12T00:00:00Z');
const T1 = Temporal.Instant.from('2026-11-12T01:00:00Z');
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));

describe.each(TEST_MARKETS)('seller cultures in market %s (database integration)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const created: string[] = [];
  let persistence: Persistence;
  let repository: PrismaSellerCultureRepository;
  let sql: Client;
  let owner: Client;

  beforeAll(async () => {
    persistence = createPersistence();
    repository = new PrismaSellerCultureRepository(persistence.service);
    sql = new Client({ connectionString: testDatabaseUrl() });
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await Promise.all([sql.connect(), owner.connect()]);
  });
  afterAll(async () => {
    for (const sellerId of created) {
      for (const table of ['seller_cultures', 'seller_admin_settings', 'seller_files']) {
        await owner.query(`DELETE FROM sellers.${table} WHERE seller_id = $1`, [sellerId]);
      }
    }
    await Promise.all([sql.end(), owner.end(), persistence.close()]);
  });

  const inUnitOf =
    (target: typeof market) =>
    <T>(work: () => Promise<T>): Promise<T> =>
      persistence.unitOfWork
        .run(target, async () => ({ ok: true as const, value: await work() }))
        .then((result) => {
          if (!result.ok) throw new Error('unit failed');
          return result.value;
        });
  const inUnit = inUnitOf(market);

  /** A seller file with its settings row, in the given Market. */
  async function insertSeller(target = market): Promise<Id<'Seller'>> {
    const sellerId = uuid7();
    created.push(sellerId);
    await sql.query(
      `INSERT INTO sellers.seller_files
         (seller_id, market_id, tenant_id, origin, approval_required_at_registration,
          draft_complete, last_changed_at, version, created_at)
       VALUES ($1, $2, $3, 'self', true, false, now(), 1, now())`,
      [sellerId, target.marketId, target.tenantId],
    );
    await sql.query(
      `INSERT INTO sellers.seller_admin_settings
         (seller_id, market_id, tenant_id, all_product_types_allowed, category_proposals_allowed,
          ai_enabled, version, created_at)
       VALUES ($1, $2, $3, true, false, false, 1, now())`,
      [sellerId, target.marketId, target.tenantId],
    );
    return sellerId as Id<'Seller'>;
  }

  const requestOf = (sellerId: Id<'Seller'>, cultureId: Id<'Culture'>, at = T0) => ({
    sellerId,
    cultureId,
    cultureCode: 'a-culture',
    by: uuid7() as Id<'Account'>,
    at,
  });
  const newCulture = () => uuid7() as Id<'Culture'>;

  const insertRaw = (
    sellerId: string,
    overrides: Record<string, unknown> = {},
    client: Client = sql,
  ) => {
    const row = {
      market_id: market.marketId,
      tenant_id: market.tenantId,
      seller_id: sellerId,
      culture_id: uuid7(),
      culture_code: 'a-culture',
      status: 'requested',
      requested_by: uuid7(),
      requested_at: T0.toString(),
      version: 1,
      updated_at: T0.toString(),
      ...overrides,
    };
    const columns = Object.keys(row);
    return sqlState(
      client,
      `INSERT INTO sellers.seller_cultures (${columns.join(', ')})
       VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(row),
    );
  };

  it('stores a request, reads it back, and keeps one row per seller and culture', async () => {
    const sellerId = await insertSeller();
    const culture = newCulture();
    const made = requestMembership(null, requestOf(sellerId, culture));
    if (made.kind !== 'changed') throw new Error('expected a request');

    expect(await inUnit(() => repository.insert(market, made.state))).toBe(true);
    expect(await inUnit(() => repository.insert(market, made.state))).toBe(false);
    expect(await inUnit(() => repository.forSeller(market, sellerId))).toEqual([made.state]);
    const among = await inUnit(() => repository.among(market, sellerId, [culture, newCulture()]));
    expect([...among.keys()]).toEqual([culture]);
  });

  it('decides a request once, with the version guard, and opens a rejected one again', async () => {
    const sellerId = await insertSeller();
    const culture = newCulture();
    const made = requestMembership(null, requestOf(sellerId, culture));
    if (made.kind !== 'changed') throw new Error('expected a request');
    await inUnit(() => repository.insert(market, made.state));

    const rejected = decideMembership(made.state, {
      decision: 'reject',
      reason: 'Not in the standard',
      by: uuid7() as Id<'Account'>,
      at: T1,
    });
    if (!rejected.ok) throw new Error('expected a decision');
    const expectRequested = { version: 1, status: 'requested' as const };
    expect(await inUnit(() => repository.transition(market, rejected.value, expectRequested))).toBe(
      true,
    );
    // The same decision read at the same version loses: the row moved on.
    expect(await inUnit(() => repository.transition(market, rejected.value, expectRequested))).toBe(
      false,
    );
    expect(await inUnit(() => repository.forSeller(market, sellerId))).toEqual([rejected.value]);

    const again = requestMembership(rejected.value, requestOf(sellerId, culture, T1));
    if (again.kind !== 'changed') throw new Error('expected a new request');
    expect(
      await inUnit(() =>
        repository.transition(market, again.state, { version: 2, status: 'rejected' }),
      ),
    ).toBe(true);
    expect(await inUnit(() => repository.forSeller(market, sellerId))).toMatchObject([
      { status: 'requested', version: 3, reason: null, decidedBy: null, decidedAt: null },
    ]);
  });

  it('lets exactly one of two racing first requests insert, and exactly one of two racing decisions win', async () => {
    const sellerId = await insertSeller();
    const culture = newCulture();
    const made = requestMembership(null, requestOf(sellerId, culture));
    if (made.kind !== 'changed') throw new Error('expected a request');

    const inserts = await Promise.all([
      inUnit(() => repository.insert(market, made.state)),
      inUnit(() => repository.insert(market, made.state)),
    ]);
    expect(inserts.filter(Boolean)).toHaveLength(1);

    const approve = (by: string) => {
      const next = decideMembership(made.state, {
        decision: 'approve',
        reason: null,
        by: by as Id<'Account'>,
        at: T1,
      });
      if (!next.ok) throw new Error('expected a decision');
      return next.value;
    };
    const decisions = await Promise.all([
      inUnit(() =>
        repository.transition(market, approve(uuid7()), { version: 1, status: 'requested' }),
      ),
      inUnit(() =>
        repository.transition(market, approve(uuid7()), { version: 1, status: 'requested' }),
      ),
    ]);
    expect(decisions.filter(Boolean)).toHaveLength(1);
    expect(await inUnit(() => repository.forSeller(market, sellerId))).toMatchObject([
      { status: 'approved', version: 2 },
    ]);
  });

  it('stores a system approval at signup with no requester or decider, and a person’s rejection with both', async () => {
    const sellerId = await insertSeller();
    const approved = approveAtSignup({ ...requestOf(sellerId, newCulture()), by: null });
    expect(await inUnit(() => repository.insert(market, approved))).toBe(true);
    expect(await inUnit(() => repository.forSeller(market, sellerId))).toEqual([approved]);
    // The database refuses a rejection that no person made, or that has no reason.
    expect(
      await insertRaw(sellerId, {
        status: 'rejected',
        decided_at: T1.toString(),
        decided_by: null,
        reason: 'x',
      }),
    ).toBe('23514');
    expect(
      await insertRaw(sellerId, {
        status: 'rejected',
        decided_at: T1.toString(),
        decided_by: uuid7(),
        reason: null,
      }),
    ).toBe('23514');
  });

  it('keeps Markets apart: another Market sees none of the rows and cannot insert for this seller', async () => {
    const sellerId = await insertSeller();
    const culture = newCulture();
    const made = requestMembership(null, requestOf(sellerId, culture));
    if (made.kind !== 'changed') throw new Error('expected a request');
    await inUnit(() => repository.insert(market, made.state));

    expect(await inUnitOf(other)(() => repository.forSeller(other, sellerId))).toEqual([]);
    expect((await inUnitOf(other)(() => repository.among(other, sellerId, [culture]))).size).toBe(
      0,
    );
    // The foreign key to the seller's file carries the Market: a row cannot name another Market's seller.
    expect(
      await insertRaw(sellerId, { market_id: other.marketId, tenant_id: other.tenantId }),
    ).toBe('23503');
  });

  it('lists the sellers with no culture row at all, and not the others', async () => {
    const bare = await insertSeller();
    const having = await insertSeller();
    const foreign = await insertSeller(other);
    await inUnit(() =>
      repository.insert(market, approveAtSignup({ ...requestOf(having, newCulture()), by: null })),
    );
    const roster = await inUnit(() => repository.sellerIdsWithoutCultures(market, 500));
    expect(roster).toContain(bare);
    expect(roster).not.toContain(having);
    expect(roster).not.toContain(foreign);
    // The cursor continues after an id, in id order, and a limit caps the page.
    const ordered = await inUnit(() => repository.sellerIdsWithoutCultures(market, 500));
    expect([...ordered].sort()).toEqual(ordered);
    const after = await inUnit(() => repository.sellerIdsWithoutCultures(market, 500, bare));
    expect(after).not.toContain(bare);
    expect(after).toEqual(ordered.filter((one) => one > bare));
    expect(await inUnit(() => repository.sellerIdsWithoutCultures(market, 1))).toHaveLength(1);
  });

  it('answers whether anyone is approved in a culture, and takes an approval back', async () => {
    const sellerId = await insertSeller();
    const culture = newCulture();
    const made = requestMembership(null, requestOf(sellerId, culture));
    if (made.kind !== 'changed') throw new Error('expected a request');
    await inUnit(() => repository.insert(market, made.state));
    expect(await inUnit(() => repository.hasApproved(market, culture))).toBe(false);

    const approved = decideMembership(made.state, {
      decision: 'approve',
      reason: null,
      by: uuid7() as Id<'Account'>,
      at: T1,
    });
    if (!approved.ok) throw new Error('expected a decision');
    await inUnit(() =>
      repository.transition(market, approved.value, { version: 1, status: 'requested' }),
    );
    expect(await inUnit(() => repository.hasApproved(market, culture))).toBe(true);
    expect(await inUnitOf(other)(() => repository.hasApproved(other, culture))).toBe(false);

    const demoted = demoteMembership(approved.value, T1);
    expect(
      await inUnit(() =>
        repository.transition(market, demoted, { version: 2, status: 'approved' }),
      ),
    ).toBe(true);
    expect(await inUnit(() => repository.hasApproved(market, culture))).toBe(false);
    expect(await inUnit(() => repository.forSeller(market, sellerId))).toMatchObject([
      { status: 'requested', reason: null, decidedBy: null, decidedAt: null, version: 3 },
    ]);
  });

  describe('constraints', () => {
    it('refuses a bad status, a bad code, a decided row with no time and a requested row with a decision', async () => {
      const sellerId = await insertSeller();
      expect(await insertRaw(sellerId, { status: 'maybe' })).toBe('23514');
      expect(await insertRaw(sellerId, { culture_code: 'Not A Code' })).toBe('23514');
      expect(await insertRaw(sellerId, { status: 'approved' })).toBe('23514');
      expect(await insertRaw(sellerId, { status: 'requested', decided_at: T1.toString() })).toBe(
        '23514',
      );
      expect(await insertRaw(sellerId, { reason: 'a reason on a request' })).toBe('23514');
      expect(
        await insertRaw(sellerId, {
          status: 'approved',
          decided_at: T0.subtract({ hours: 1 }).toString(),
        }),
      ).toBe('23514');
      expect(await insertRaw(sellerId, { updated_at: T0.subtract({ hours: 1 }).toString() })).toBe(
        '23514',
      );
      expect(await insertRaw(sellerId, { reason: '' })).toBe('23514');
      expect(await insertRaw(sellerId, { reason: ' padded ' })).toBe('23514');
      expect(await insertRaw(sellerId, { reason: 'x'.repeat(301) })).toBe('23514');
      expect(await insertRaw(sellerId, { version: 0 })).toBe('23514');
      expect(await insertRaw(sellerId, { market_id: 'au' })).toBe('23514');
      expect(await insertRaw(sellerId, { tenant_id: 'Not Valid' })).toBe('23514');
      expect(await insertRaw(sellerId)).toBeNull();
    });
  });

  describe('grants (as the application role)', () => {
    it('lets the application insert and update the decision columns, and nothing else', async () => {
      const sellerId = await insertSeller();
      const culture = uuid7();
      expect(await insertRaw(sellerId, { culture_id: culture })).toBeNull();
      expect(
        await sqlState(
          sql,
          `UPDATE sellers.seller_cultures SET status = 'approved', decided_at = now(), version = 2
            WHERE seller_id = $1 AND culture_id = $2`,
          [sellerId, culture],
        ),
      ).toBeNull();
      // Never deleted, and the identity of a row never changes.
      expect(
        await sqlState(sql, `DELETE FROM sellers.seller_cultures WHERE seller_id = $1`, [sellerId]),
      ).toBe('42501');
      for (const column of ['culture_id', 'culture_code', 'seller_id', 'market_id', 'tenant_id']) {
        const value = column === 'culture_id' ? uuid7() : column === 'seller_id' ? uuid7() : 'zz-x';
        expect(
          await sqlState(
            sql,
            `UPDATE sellers.seller_cultures SET ${column} = $1 WHERE seller_id = $2`,
            [value, sellerId],
          ),
        ).toBe('42501');
      }
    });
  });
});
