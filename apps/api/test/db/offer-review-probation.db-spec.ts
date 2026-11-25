import { Logger } from '@nestjs/common';
import { Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { AuditEntry, Id, MarketContext } from '@mondapac/shared-kernel';
import { testCallContext } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { SellerReviewProbation } from '../../src/modules/catalog/application/seller-review-probation';
import { CategoryOfferReviewFlags } from '../../src/modules/catalog/domain/category-offer-review-flags';
import { Offer } from '../../src/modules/catalog/domain/offer';
import { Product } from '../../src/modules/catalog/domain/product';
import { simpleProductType } from '../../src/modules/catalog/domain/product-types/simple';
import { PrismaCategoryOfferReviewFlagsStore } from '../../src/modules/catalog/infrastructure/prisma-category-offer-review-flags.store';
import { PrismaOfferRepository } from '../../src/modules/catalog/infrastructure/prisma-offer.repository';
import { PrismaProductRepository } from '../../src/modules/catalog/infrastructure/prisma-product.repository';
import { PrismaSellerReviewStandingRepository } from '../../src/modules/catalog/infrastructure/prisma-seller-review-standing.repository';
import { PrismaOfferReviewFlagsRepository } from '../../src/modules/sellers/infrastructure/prisma-offer-review-flags.repository';
import { SystemClock } from '../../src/platform/clock/system-clock';
import { FLAGS_OFF } from '../support/catalog-seller-review-fakes';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// Risk-based Offer approval slice 4 on PostgreSQL, for both Market fixtures: the seller's review
// standing and its credits (catalog), the Offer review flags of platform categories and their change
// log (catalog), and the seller's three Offer review flags and their change log (sellers), as the
// application role, with the guard triggers of the migration. The tables' times are checked
// against the statement time, so this spec runs on the system clock.

let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const ids = { next: <K extends string>() => uuid7() as Id<K> };
const clock = new SystemClock();

describe.each(TEST_MARKETS)('Offer review probation in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const createdSellers: string[] = [];
  let persistence: Persistence;
  let sql: Client;
  let owner: Client;
  let standings: PrismaSellerReviewStandingRepository;
  let categoryFlags: PrismaCategoryOfferReviewFlagsStore;
  let sellerFlags: PrismaOfferReviewFlagsRepository;
  let products: PrismaProductRepository;
  let offers: PrismaOfferRepository;

  beforeAll(async () => {
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
    persistence = createPersistence();
    sql = new Client({ connectionString: testDatabaseUrl() });
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await Promise.all([sql.connect(), owner.connect()]);
    standings = new PrismaSellerReviewStandingRepository(persistence.service);
    categoryFlags = new PrismaCategoryOfferReviewFlagsStore(persistence.service);
    sellerFlags = new PrismaOfferReviewFlagsRepository(persistence.service);
    products = new PrismaProductRepository(persistence.service);
    offers = new PrismaOfferRepository(persistence.service, ids);
  });
  afterAll(async () => {
    for (const sellerId of createdSellers) {
      // The change log is insert-only even for the owner: its rows stay with the throwaway database.
      for (const table of ['seller_admin_settings']) {
        await owner.query(`DELETE FROM sellers.${table} WHERE seller_id = $1`, [sellerId]);
      }
    }
    await Promise.all([sql.end(), owner.end(), persistence.close()]);
    jest.restoreAllMocks();
  });

  const inUnitOf =
    (target: MarketContext) =>
    <T>(work: () => Promise<T>): Promise<T> =>
      persistence.unitOfWork
        .run(target, async () => ({ ok: true as const, value: await work() }))
        .then((result) => {
          if (!result.ok) throw new Error('unit failed');
          return result.value;
        });
  const inUnit = inUnitOf(market);

  /** A published-able product and a draft Offer of it by `sellerId`. */
  async function offerOf(sellerId: Id<'Seller'>, target = market) {
    const now = clock.now();
    const product = Product.create({
      id: uuid7() as Id<'Product'>,
      marketId: target.marketId,
      scope: 'PLATFORM',
      sellerId: null,
      handler: simpleProductType,
      familyCode: 'default',
      productCode: `Q${uuid7().replaceAll('-', '').slice(-12).toUpperCase()}`,
      variantId: uuid7() as Id<'Variant'>,
      now,
    });
    if (!product.ok) throw new Error(product.error.code);
    const offer = Offer.create({
      id: uuid7() as Id<'Offer'>,
      marketId: target.marketId,
      sellerId,
      productId: product.value.state.id,
      sellerSku: `S-${uuid7().slice(-12)}`,
      conditionCode: 'new',
      description: { 'en-AU': 'Fresh dates' },
      now,
    });
    if (!offer.ok) throw new Error(offer.error.code);
    await inUnitOf(target)(async () => {
      await products.add(target, product.value);
      await offers.add(target, offer.value, {
        kind: 'seller',
        accountId: uuid7() as Id<'Account'>,
      });
    });
    return { productId: product.value.state.id, offerId: offer.value.state.id };
  }

  async function category(target = market): Promise<Id<'Category'>> {
    const id = uuid7();
    await sql.query(
      `INSERT INTO catalog.platform_categories
         (id, market_id, tenant_id, slug, status, created_by_kind, version, created_at)
       VALUES ($1, $2, $3, $4, 'active', 'seed', 1, now())`,
      [id, target.marketId, target.tenantId, `orp-${id.slice(-12)}`],
    );
    return id as Id<'Category'>;
  }

  async function seller(target = market): Promise<Id<'Seller'>> {
    const sellerId = uuid7();
    createdSellers.push(sellerId);
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

  describe('seller review standing', () => {
    it('is created lazily by the lock, raised by one per write, and read with its count', async () => {
      const sellerId = uuid7() as Id<'Seller'>;
      const { productId, offerId } = await offerOf(sellerId);
      await inUnit(async () => {
        const locked = await standings.lock(market, sellerId, clock.now());
        expect(locked.state).toMatchObject({ epoch: 1, version: 2, trustedAt: null });
        expect(
          await standings.credit(market, {
            sellerId,
            epoch: 1,
            productId,
            offerId,
            creditedAt: clock.now(),
          }),
        ).toBe(true);
        // Once per product per epoch.
        expect(
          await standings.credit(market, {
            sellerId,
            epoch: 1,
            productId,
            offerId,
            creditedAt: clock.now(),
          }),
        ).toBe(false);
        locked.stampTrust({ count: 1, probationOffers: 1, now: clock.now() });
        await standings.save(market, locked);
      });
      const read = await inUnit(() => standings.read(market, sellerId));
      expect(read).toMatchObject({ count: 1, state: { version: 3, epoch: 1 } });
      expect(read!.state.trustedAt).not.toBeNull();
      // Per Market: the other Market has no standing of this seller.
      expect(await inUnitOf(other)(() => standings.read(other, sellerId))).toBeNull();
    });

    it('refuses a stale save, a credit outside the current epoch, and an owner edit past the guard', async () => {
      const sellerId = uuid7() as Id<'Seller'>;
      const { productId, offerId } = await offerOf(sellerId);
      const first = await inUnit(() => standings.lock(market, sellerId, clock.now()));
      await inUnit(() => standings.lock(market, sellerId, clock.now()));
      await expect(inUnit(() => standings.save(market, first))).rejects.toThrow();
      await expect(
        inUnit(() =>
          standings.credit(market, {
            sellerId,
            epoch: 2,
            productId,
            offerId,
            creditedAt: clock.now(),
          }),
        ),
      ).rejects.toThrow();
      for (const statement of [
        `UPDATE catalog.seller_review_standings SET version = version + 2, updated_at = now()
          WHERE market_id = $1 AND seller_id = $2`,
        `UPDATE catalog.seller_review_standings SET epoch = epoch + 2, version = version + 1,
           updated_at = now() WHERE market_id = $1 AND seller_id = $2`,
        `DELETE FROM catalog.seller_review_standings WHERE market_id = $1 AND seller_id = $2`,
      ]) {
        await expect(owner.query(statement, [code, sellerId])).rejects.toThrow();
      }
    });

    it('inserts a standing only in its start state, even for the owner (Hassan N1)', async () => {
      const insert = (columns: string, values: string) =>
        owner.query(
          `INSERT INTO catalog.seller_review_standings
             (market_id, tenant_id, seller_id, created_at, updated_at, ${columns})
           VALUES ($1, $2, $3, now(), now(), ${values})`,
          [code, market.tenantId, uuid7()],
        );
      const start = {
        epoch: '1',
        target_kind: "'initial'",
        consecutive_changes_needed: '0',
        trusted_at: 'NULL',
        trust_lost_at: 'NULL',
        version: '1',
      };
      const row = (patch: Partial<typeof start>) => {
        const all = { ...start, ...patch };
        return insert(Object.keys(all).join(', '), Object.values(all).join(', '));
      };
      await expect(row({})).resolves.toBeDefined();
      for (const patch of [
        { epoch: '2' },
        { target_kind: "'after-misconduct'", epoch: '2', trust_lost_at: 'now()' },
        { trusted_at: 'now()' },
        { trust_lost_at: 'now()' },
        { consecutive_changes_needed: '1' },
        { version: '2' },
      ]) {
        await expect(row(patch)).rejects.toThrow(/start state/);
      }
    });

    it('serialises two units on one seller: no credit lost, no deadlock (Mojtaba L1)', async () => {
      const audits: AuditEntry[] = [];
      const probation = new SellerReviewProbation({
        standings,
        sellerFlags: { flagsOf: () => Promise.resolve(FLAGS_OFF) },
        inputs: { probationOffers: () => Promise.resolve(2) },
        audit: {
          record: (_c, entry) => {
            audits.push(entry);
            return Promise.resolve();
          },
        },
      });
      const context = testCallContext(market, 'system');
      const sellerId = uuid7() as Id<'Seller'>;
      const [first, second] = [await offerOf(sellerId), await offerOf(sellerId)];
      const approve = async (made: { productId: Id<'Product'>; offerId: Id<'Offer'> }) => {
        const prepared = await probation.prepare(context, sellerId);
        await inUnit(() =>
          probation.recordApproval(context, prepared, { ...made, now: clock.now() }),
        );
      };
      // Two approvals at once on a seller with no standing yet: both create-or-lock the same row.
      await Promise.all([approve(first), approve(second)]);
      const both = await inUnit(() => standings.read(market, sellerId));
      expect(both).toMatchObject({ count: 2, state: { epoch: 1 } });
      expect(both!.state.trustedAt).not.toBeNull();
      expect(audits.map((a) => a.action)).toEqual(['catalog.seller-review.trusted']);

      // An approval against a Changes needed of the same seller: both finish, in some order.
      const other = uuid7() as Id<'Seller'>;
      const made = await offerOf(other);
      const preparedOther = await probation.prepare(context, other);
      await Promise.all([
        inUnit(() =>
          probation.recordApproval(context, preparedOther, { ...made, now: clock.now() }),
        ),
        inUnit(() => probation.recordChangesNeeded(context, preparedOther, clock.now())),
      ]);
      const mixed = await inUnit(() => standings.read(market, other));
      expect(mixed).toMatchObject({ count: 1, state: { epoch: 1 } });
    });

    it('keeps credits insert-only and binds a credit to the Offer of the same seller', async () => {
      const sellerId = uuid7() as Id<'Seller'>;
      const { productId, offerId } = await offerOf(sellerId);
      const stranger = uuid7() as Id<'Seller'>;
      await inUnit(async () => {
        await standings.lock(market, sellerId, clock.now());
        await standings.lock(market, stranger, clock.now());
        await standings.credit(market, {
          sellerId,
          epoch: 1,
          productId,
          offerId,
          creditedAt: clock.now(),
        });
      });
      await expect(
        inUnit(() =>
          standings.credit(market, {
            sellerId: stranger,
            epoch: 1,
            productId,
            offerId,
            creditedAt: clock.now(),
          }),
        ),
      ).rejects.toThrow();
      await expect(
        owner.query(`DELETE FROM catalog.seller_review_credits WHERE seller_id = $1`, [sellerId]),
      ).rejects.toThrow();
      await expect(
        owner.query(`UPDATE catalog.seller_review_credits SET epoch = 1 WHERE seller_id = $1`, [
          sellerId,
        ]),
      ).rejects.toThrow();
    });

    it('runs the probation flow on PostgreSQL: Trusted at N, a restart, a misconduct revocation', async () => {
      const audits: AuditEntry[] = [];
      const probation = new SellerReviewProbation({
        standings,
        sellerFlags: { flagsOf: () => Promise.resolve(FLAGS_OFF) },
        inputs: { probationOffers: () => Promise.resolve(2) },
        audit: {
          record: (_c, entry) => {
            audits.push(entry);
            return Promise.resolve();
          },
        },
      });
      const context = testCallContext(market, 'system');
      const sellerId = uuid7() as Id<'Seller'>;
      const made = [await offerOf(sellerId), await offerOf(sellerId), await offerOf(sellerId)];

      // Two Changes needed in a row restart the epoch.
      for (let n = 0; n < 2; n += 1) {
        const prepared = await probation.prepare(context, sellerId);
        await inUnit(() => probation.recordChangesNeeded(context, prepared, clock.now()));
      }
      expect(await inUnit(() => standings.read(market, sellerId))).toMatchObject({
        count: 0,
        state: { epoch: 2, consecutiveChangesNeeded: 0 },
      });

      for (const one of made.slice(0, 2)) {
        const prepared = await probation.prepare(context, sellerId);
        await inUnit(() =>
          probation.recordApproval(context, prepared, { ...one, now: clock.now() }),
        );
      }
      const trusted = await inUnit(() => standings.read(market, sellerId));
      expect(trusted).toMatchObject({ count: 2, state: { epoch: 2 } });
      expect(trusted!.state.trustedAt).not.toBeNull();
      expect(audits.map((a) => a.action)).toEqual([
        'catalog.seller-review.restarted',
        'catalog.seller-review.trusted',
      ]);

      // A misconduct revocation (defined and tested only in slice 4) passes the guard.
      await inUnit(async () => {
        const locked = await standings.lock(market, sellerId, clock.now());
        locked.revokeForMisconduct({ now: clock.now() });
        await standings.save(market, locked);
      });
      expect(await inUnit(() => standings.read(market, sellerId))).toMatchObject({
        count: 0,
        state: { epoch: 3, targetKind: 'after-misconduct', trustedAt: null },
      });
    });
  });

  describe('category Offer review flags', () => {
    const change = (
      categoryId: Id<'Category'>,
      flag: 'always-review' | 'review-stop',
      on: boolean,
      reason = 'Recall notice',
    ) =>
      inUnit(async () => {
        const flags = await categoryFlags.find(market, categoryId);
        const seen = flags.state.version;
        const now = clock.now();
        const by = uuid7() as Id<'Account'>;
        const switched = flags.set({ flag, on, by, now });
        if (switched === null) return 'unchanged';
        if (!(await categoryFlags.save(market, flags, seen))) return 'stale';
        await categoryFlags.appendChange(market, {
          id: uuid7() as Id<'CategoryOfferReviewChange'>,
          categoryId,
          flag,
          previous: switched.previous,
          next: on,
          reason,
          by,
          at: now,
        });
        return 'saved';
      });

    it('creates the row at version 1 on the first change, raises it by one, lists flagged ones', async () => {
      const categoryId = await category();
      expect(await inUnit(() => categoryFlags.categoryExists(market, categoryId))).toBe(true);
      expect(await inUnitOf(other)(() => categoryFlags.categoryExists(other, categoryId))).toBe(
        false,
      );
      expect(await change(categoryId, 'always-review', true)).toBe('saved');
      expect(await change(categoryId, 'review-stop', true)).toBe('saved');
      const found = await inUnit(() => categoryFlags.find(market, categoryId));
      expect(found.state).toMatchObject({ version: 2 });
      expect(found.valueOf('always-review')).toBe(true);
      const listed = await inUnit(() => categoryFlags.listFlagged(market));
      expect(listed).toContainEqual(
        expect.objectContaining({ categoryId, alwaysReview: true, reviewStop: true, version: 2 }),
      );
      expect(await change(categoryId, 'always-review', false)).toBe('saved');
      expect(await change(categoryId, 'review-stop', false)).toBe('saved');
      expect(
        (await inUnit(() => categoryFlags.listFlagged(market))).map((r) => r.categoryId),
      ).not.toContain(categoryId);
      const log = await owner.query(
        `SELECT flag, previous_value, new_value FROM catalog.category_offer_review_changes
          WHERE market_id = $1 AND category_id = $2 ORDER BY changed_at, id`,
        [code, categoryId],
      );
      expect(log.rows).toHaveLength(4);
    });

    it('answers false for a lost race on the create and on an update', async () => {
      const categoryId = await category();
      const stale = await inUnit(() => categoryFlags.find(market, categoryId));
      stale.set({
        flag: 'always-review',
        on: true,
        by: uuid7() as Id<'Account'>,
        now: clock.now(),
      });
      expect(await change(categoryId, 'review-stop', true)).toBe('saved');
      expect(await inUnit(() => categoryFlags.save(market, stale, 0))).toBe(false);
      const atOne = await inUnit(() => categoryFlags.find(market, categoryId));
      expect(await change(categoryId, 'review-stop', false)).toBe('saved');
      atOne.set({
        flag: 'always-review',
        on: true,
        by: uuid7() as Id<'Account'>,
        now: clock.now(),
      });
      expect(await inUnit(() => categoryFlags.save(market, atOne, 1))).toBe(false);
    });

    it('refuses an untrimmed reason, an owner DELETE, a version jump and a log edit', async () => {
      const categoryId = await category();
      await expect(change(categoryId, 'always-review', true, ' padded ')).rejects.toThrow();
      expect(await change(categoryId, 'always-review', true)).toBe('saved');
      await expect(
        owner.query(
          `UPDATE catalog.category_offer_review_flags SET version = version + 2
            WHERE market_id = $1 AND category_id = $2`,
          [code, categoryId],
        ),
      ).rejects.toThrow();
      await expect(
        owner.query(
          `DELETE FROM catalog.category_offer_review_flags WHERE market_id = $1 AND category_id = $2`,
          [code, categoryId],
        ),
      ).rejects.toThrow();
      await expect(
        owner.query(
          `UPDATE catalog.category_offer_review_changes SET reason = 'x' WHERE category_id = $1`,
          [categoryId],
        ),
      ).rejects.toThrow();
    });

    it('answers no published categories for an unknown product or one never published', async () => {
      const sellerId = uuid7() as Id<'Seller'>;
      const { productId } = await offerOf(sellerId);
      expect(await inUnit(() => categoryFlags.publishedCategoryIds(market, productId))).toEqual([]);
      expect(
        await inUnit(() => categoryFlags.publishedCategoryIds(market, uuid7() as Id<'Product'>)),
      ).toEqual([]);
    });

    it('never saves flags of another Market', async () => {
      const categoryId = await category(other);
      const flags = CategoryOfferReviewFlags.none(other.marketId, categoryId);
      flags.set({ flag: 'review-stop', on: true, by: uuid7() as Id<'Account'>, now: clock.now() });
      await expect(inUnit(() => categoryFlags.save(market, flags, 0))).rejects.toThrow();
    });
  });

  describe('seller Offer review flags', () => {
    it('reads the three flags off, sets one with who and when, raising the version by one', async () => {
      const sellerId = await seller();
      const read = await inUnit(() => sellerFlags.read(market, sellerId));
      expect(read).toMatchObject({
        trustedFromStart: { on: false, changedAt: null, changedBy: null },
        fullReview: { on: false },
        reviewStop: { on: false },
        version: 1,
      });
      const by = uuid7() as Id<'Account'>;
      const at = clock.now();
      await inUnit(async () => {
        expect(
          await sellerFlags.set(market, sellerId, {
            flag: 'review-stop',
            on: true,
            by,
            at,
            expectedVersion: 1,
          }),
        ).toBe(true);
        await sellerFlags.appendChange(market, {
          id: uuid7() as Id<'OfferReviewFlagChange'>,
          sellerId,
          flag: 'review-stop',
          previous: false,
          next: true,
          reason: 'Complaints',
          by,
          at,
        });
      });
      const after = await inUnit(() => sellerFlags.read(market, sellerId));
      expect(after).toMatchObject({ reviewStop: { on: true, changedBy: by }, version: 2 });
      expect(Temporal.Instant.compare(after!.reviewStop.changedAt!, at)).toBe(0);
      // A stale version matches no row.
      expect(
        await inUnit(() =>
          sellerFlags.set(market, sellerId, {
            flag: 'full-review',
            on: true,
            by,
            at: clock.now(),
            expectedVersion: 1,
          }),
        ),
      ).toBe(false);
      expect(await inUnitOf(other)(() => sellerFlags.read(other, sellerId))).toBeNull();
    });

    it('counts the sellers of the Market with their stop on (the stop banner, slice 5)', async () => {
      const before = await inUnit(() => sellerFlags.countStopped(market));
      const otherBefore = await inUnitOf(other)(() => sellerFlags.countStopped(other));
      const sellerId = await seller();
      await seller();
      expect(await inUnit(() => sellerFlags.countStopped(market))).toBe(before);
      await inUnit(() =>
        sellerFlags.set(market, sellerId, {
          flag: 'review-stop',
          on: true,
          by: uuid7() as Id<'Account'>,
          at: clock.now(),
          expectedVersion: 1,
        }),
      );
      expect(await inUnit(() => sellerFlags.countStopped(market))).toBe(before + 1);
      expect(await inUnitOf(other)(() => sellerFlags.countStopped(other))).toBe(otherBefore);
    });

    it('keeps the change log insert-only with a checked reason and a value that changed', async () => {
      const sellerId = await seller();
      const entry = {
        id: uuid7() as Id<'OfferReviewFlagChange'>,
        sellerId,
        flag: 'full-review' as const,
        previous: false,
        next: true,
        reason: 'Checked',
        by: uuid7() as Id<'Account'>,
        at: clock.now(),
      };
      await inUnit(() => sellerFlags.appendChange(market, entry));
      for (const bad of [
        { ...entry, id: uuid7() as Id<'OfferReviewFlagChange'>, reason: ' padded ' },
        { ...entry, id: uuid7() as Id<'OfferReviewFlagChange'>, next: false },
        {
          ...entry,
          id: uuid7() as Id<'OfferReviewFlagChange'>,
          at: clock.now().subtract({ hours: 1 }),
        },
      ]) {
        await expect(inUnit(() => sellerFlags.appendChange(market, bad))).rejects.toThrow();
      }
      for (const statement of [
        `UPDATE sellers.offer_review_flag_changes SET reason = 'x' WHERE seller_id = $1`,
        `DELETE FROM sellers.offer_review_flag_changes WHERE seller_id = $1`,
      ]) {
        await expect(owner.query(statement, [sellerId])).rejects.toThrow();
      }
      // An "on" switch must say who switched it.
      await expect(
        owner.query(
          `UPDATE sellers.seller_admin_settings SET offer_review_stop = true, version = version + 1
            WHERE seller_id = $1`,
          [sellerId],
        ),
      ).rejects.toThrow();
    });
  });
});
