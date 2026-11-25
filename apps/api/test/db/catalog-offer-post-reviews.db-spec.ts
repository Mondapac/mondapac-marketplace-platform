import { Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  FixedClock,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import type { AuthorisationCheck } from '../../src/platform/authz';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';
import { receivePostReviewReason } from '../../src/modules/catalog/application/offer-post-review/post-review-intake';
import { AdminOfferPostReviewTakeDown } from '../../src/modules/catalog/application/use-cases/offer-post-review-take-down.use-case';
import { Offer } from '../../src/modules/catalog/domain/offer';
import { OfferPendingChange } from '../../src/modules/catalog/domain/offer-pending-change';
import { OfferPostReview } from '../../src/modules/catalog/domain/offer-post-review';
import { Product } from '../../src/modules/catalog/domain/product';
import { simpleProductType } from '../../src/modules/catalog/domain/product-types/simple';
import { PrismaOfferPendingChangeRepository } from '../../src/modules/catalog/infrastructure/prisma-offer-pending-change.repository';
import { PrismaOfferPostReviewRepository } from '../../src/modules/catalog/infrastructure/prisma-offer-post-review.repository';
import { PrismaOfferRepository } from '../../src/modules/catalog/infrastructure/prisma-offer.repository';
import { PrismaProductRepository } from '../../src/modules/catalog/infrastructure/prisma-product.repository';
import { NO_AUDIT, prismaOfferEditReview } from '../support/catalog-offer-edit-review-fakes';
import { memoryProbation } from '../support/catalog-seller-review-fakes';
import { RecordingOutbox } from '../support/catalog-tag-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';

// The post-publication review list (risk-based Offer approval slice 6): the tables
// catalog.offer_post_reviews and catalog.offer_post_review_reasons and their repository on
// PostgreSQL, for both Market fixtures. A row is born open at version 1, gains reasons while open,
// is decided once, never deleted (guard trigger); one open row per Offer (partial unique); a
// reason's source is received once (insert-only key); every read carries the Market.

const T0 = Temporal.Instant.from('2026-11-25T00:00:00Z');
/** The triggers check updated_at, decided_at and received_at against the statement time. */
const nowInstant = (): Temporal.Instant => Temporal.Instant.fromEpochMilliseconds(Date.now());
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const ids = { next: <K extends string>() => uuid7() as Id<K> };
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);

describe.each(TEST_MARKETS)(
  'catalog Offer post-publication reviews in market %s (database integration)',
  (code) => {
    const market = marketOf(code);
    const other = marketOf(otherMarketOf(code));
    let persistence: Persistence;
    let owner: Client;
    let products: PrismaProductRepository;
    let offers: PrismaOfferRepository;
    let reviews: PrismaOfferPostReviewRepository;
    const sellerId = uuid7() as Id<'Seller'>;
    const sellerAccount = uuid7() as Id<'Account'>;
    const seller = { kind: 'seller' as const, accountId: sellerAccount };

    beforeAll(async () => {
      persistence = createPersistence();
      owner = new Client({ connectionString: ownerTestDatabaseUrl() });
      await owner.connect();
      products = new PrismaProductRepository(persistence.service);
      offers = new PrismaOfferRepository(persistence.service, ids);
      reviews = new PrismaOfferPostReviewRepository(persistence.service);
    });
    afterAll(async () => {
      await owner.end();
      await persistence.close();
    });

    const unit = <T>(work: () => Promise<T>) =>
      persistence.unitOfWork.run(market, async () => ({ ok: true as const, value: await work() }));
    const read = async <T>(work: () => Promise<T>): Promise<T> => {
      const done = await unit(work);
      if (!done.ok) throw new Error('read failed');
      return done.value;
    };

    /** The constraint a raw statement of the owner violated (node-postgres reports its name). */
    const pgConstraintOf = async (outcome: Promise<unknown>): Promise<string | null> => {
      try {
        await outcome;
        return null;
      } catch (error) {
        return (error as { constraint?: string }).constraint ?? 'not-a-constraint';
      }
    };

    /** A published Offer (SEALED_ORIGINAL, PLATFORM product), as the submit leaves it. */
    async function liveOffer(): Promise<{ offerId: Id<'Offer'>; productId: Id<'Product'> }> {
      const product = Product.create({
        id: uuid7() as Id<'Product'>,
        marketId: market.marketId,
        scope: 'PLATFORM',
        sellerId: null,
        handler: simpleProductType,
        familyCode: 'default',
        productCode: `P${uuid7().replaceAll('-', '').slice(-12).toUpperCase()}`,
        variantId: uuid7() as Id<'Variant'>,
        now: T0,
      });
      if (!product.ok) throw new Error(product.error.code);
      const created = Offer.create({
        id: uuid7() as Id<'Offer'>,
        marketId: market.marketId,
        sellerId,
        productId: product.value.state.id,
        sellerSku: `S-${uuid7().slice(-12)}`,
        conditionCode: 'new',
        description: { 'en-AU': 'Fresh dates' },
        now: T0,
      });
      if (!created.ok) throw new Error(created.error.code);
      const offerId = created.value.state.id;
      await unit(async () => {
        await products.add(market, product.value);
        await offers.add(market, created.value, seller);
      });
      await unit(async () => {
        const offer = (await offers.findById(market, offerId))!;
        offer.setHandling({ handling: 'SEALED_ORIGINAL', now: T0 });
        await offers.save(market, offer, seller);
      });
      await unit(async () => {
        const offer = (await offers.findById(market, offerId))!;
        offer.submit({ approvalRequired: false, now: T0 });
        await offers.save(market, offer, seller);
      });
      return { offerId, productId: product.value.state.id };
    }

    const opened = (
      offerId: Id<'Offer'>,
      productId: Id<'Product'>,
      reason: 'sample' | 'price-no-reference' = 'price-no-reference',
    ) => {
      const made = OfferPostReview.open({
        id: uuid7() as Id<'OfferPostReview'>,
        marketId: market.marketId,
        offerId,
        sellerId,
        productId,
        reason,
        sample: reason === 'sample' ? { percent: 10, doubled: true } : null,
        now: nowInstant(),
      });
      if (!made.ok) throw new Error(made.error.code);
      return made.value;
    };

    it('stores an open row and reads it back by id and by Offer, never from another Market', async () => {
      const { offerId, productId } = await liveOffer();
      const review = opened(offerId, productId, 'sample');
      await unit(() => reviews.insert(market, review));
      const back = await read(async () => ({
        byId: await reviews.findById(market, review.state.id),
        open: await reviews.findOpenByOffer(market, offerId),
      }));
      expect(back.byId?.state).toEqual(review.state);
      expect(back.open?.state.id).toBe(review.state.id);
      const foreign = await persistence.unitOfWork.run(other, async () => ({
        ok: true as const,
        value: [
          await reviews.findById(other, review.state.id),
          await reviews.findOpenByOffer(other, offerId),
          await reviews.count(other, {}),
        ],
      }));
      expect(foreign.ok && foreign.value.slice(0, 2)).toEqual([null, null]);
      const row = await owner.query(
        `SELECT tenant_id, reasons, sample_percent, sample_doubled, status, version
         FROM catalog.offer_post_reviews WHERE id = $1`,
        [review.state.id],
      );
      expect(row.rows).toEqual([
        {
          tenant_id: market.tenantId,
          reasons: ['sample'],
          sample_percent: 10,
          sample_doubled: true,
          status: 'open',
          version: 1,
        },
      ]);
    });

    it('keeps one open row per Offer (partial unique), answered as a lost race', async () => {
      const { offerId, productId } = await liveOffer();
      await unit(() => reviews.insert(market, opened(offerId, productId)));
      await expect(
        unit(() => reviews.insert(market, opened(offerId, productId))),
      ).rejects.toBeInstanceOf(StaleAggregateError);
    });

    it('adds a reason on the version read, decides once, and then opens a new row', async () => {
      const { offerId, productId } = await liveOffer();
      const review = opened(offerId, productId);
      await unit(() => reviews.insert(market, review));
      const first = OfferPostReview.restore(review.state);
      first.addReason({
        reason: 'sample',
        sample: { percent: 5, doubled: false },
        now: nowInstant(),
      });
      const stale = OfferPostReview.restore(review.state);
      stale.addReason({ reason: 'price-recheck-outside', now: nowInstant() });
      expect(
        await read(async () => [
          await reviews.save(market, first),
          await reviews.save(market, stale),
        ]),
      ).toEqual([true, false]);
      const decided = (await read(() => reviews.findById(market, review.state.id)))!;
      decided.approve({ accountId: uuid7() as Id<'Account'>, note: 'Fine', now: nowInstant() });
      expect(await read(() => reviews.save(market, decided))).toBe(true);
      expect(await read(() => reviews.findOpenByOffer(market, offerId))).toBeNull();
      await unit(() => reviews.insert(market, opened(offerId, productId)));
      expect(await read(() => reviews.count(market, { status: 'approved' }))).toBeGreaterThan(0);
    });

    it('receives each source once (idempotent intake), keyed on the Market', async () => {
      const { offerId, productId } = await liveOffer();
      const source = uuid7();
      const intake = () =>
        read(() =>
          receivePostReviewReason({ postReviews: reviews, ids }, market, {
            offerId,
            sellerId,
            productId,
            reason: 'price-no-reference',
            sourceRef: source,
            now: nowInstant(),
          }),
        );
      expect(await intake()).toBe('opened');
      expect(await intake()).toBe('duplicate');
      const rows = await owner.query(
        `SELECT count(*)::int AS n FROM catalog.offer_post_review_reasons
         WHERE market_id = $1 AND offer_id = $2`,
        [code, offerId],
      );
      expect(rows.rows).toEqual([{ n: 1 }]);
      expect(
        await read(() =>
          reviews.received(market, { offerId, reason: 'price-no-reference', sourceRef: source }),
        ),
      ).toBe(true);
      const foreign = await persistence.unitOfWork.run(other, async () => ({
        ok: true as const,
        value: await reviews.received(other, {
          offerId,
          reason: 'price-no-reference',
          sourceRef: source,
        }),
      }));
      expect(foreign).toEqual({ ok: true, value: false });
    });

    it('refuses a delete, a dropped reason, a changed sample and any change after a decision', async () => {
      const { offerId, productId } = await liveOffer();
      const review = opened(offerId, productId, 'sample');
      await unit(() => reviews.insert(market, review));
      const id = review.state.id;
      await expect(
        owner.query(`DELETE FROM catalog.offer_post_reviews WHERE id = $1`, [id]),
      ).rejects.toThrow('DELETE is not allowed');
      await expect(
        owner.query(
          `UPDATE catalog.offer_post_reviews SET offer_id = $2, version = version + 1,
             updated_at = now() WHERE id = $1`,
          [id, uuid7()],
        ),
      ).rejects.toThrow();
      await expect(
        owner.query(
          `UPDATE catalog.offer_post_reviews SET reasons = '{price-no-reference}',
             version = version + 1, updated_at = now() WHERE id = $1`,
          [id],
        ),
      ).rejects.toThrow('only gains reasons');
      await expect(
        owner.query(
          `UPDATE catalog.offer_post_reviews SET reasons = '{sample,price-no-reference}',
             sample_percent = 50, version = version + 1, updated_at = now() WHERE id = $1`,
          [id],
        ),
      ).rejects.toThrow('the sample is set once');
      await expect(
        owner.query(
          `UPDATE catalog.offer_post_reviews SET reasons = '{sample,sample}',
             version = version + 1, updated_at = now() WHERE id = $1`,
          [id],
        ),
      ).rejects.toThrow('a reason is listed once');
      await expect(
        owner.query(
          `UPDATE catalog.offer_post_reviews SET reasons = '{sample,price-no-reference}',
             version = version + 2, updated_at = now() WHERE id = $1`,
          [id],
        ),
      ).rejects.toThrow('version must rise by one');
      await owner.query(
        `UPDATE catalog.offer_post_reviews SET status = 'approved', decided_at = now(),
           decided_by_account_id = $2, version = version + 1, updated_at = now() WHERE id = $1`,
        [id, sellerAccount],
      );
      await expect(
        owner.query(
          `UPDATE catalog.offer_post_reviews SET note = 'x', version = version + 1,
             updated_at = now() WHERE id = $1`,
          [id],
        ),
      ).rejects.toThrow('a decided row never changes');
      await expect(
        owner.query(
          `INSERT INTO catalog.offer_post_reviews (id, market_id, tenant_id, offer_id, seller_id,
             product_id, status, reasons, opened_at, updated_at, decided_at, decided_by_account_id,
             version)
           VALUES ($1, $2, $3, $4, $5, $6, 'approved', '{price-no-reference}', now(), now(), now(),
             $7, 1)`,
          [uuid7(), code, market.tenantId, offerId, sellerId, productId, sellerAccount],
        ),
      ).rejects.toThrow('inserted open at version 1');
    });

    it('checks the columns: known reasons, a sample percent only with sample, no note while open', async () => {
      const { offerId, productId } = await liveOffer();
      const insert = (columns: Record<string, unknown>) => {
        const row = {
          id: uuid7(),
          market_id: code,
          tenant_id: market.tenantId,
          offer_id: offerId,
          seller_id: sellerId,
          product_id: productId,
          status: 'open',
          reasons: ['price-no-reference'],
          sample_percent: null,
          opened_at: new Date(),
          updated_at: null as Date | null,
          version: 1,
          ...columns,
        };
        row.updated_at = row.opened_at;
        const keys = Object.keys(row);
        return pgConstraintOf(
          owner.query(
            `INSERT INTO catalog.offer_post_reviews (${keys.join(', ')})
             VALUES (${keys.map((_, n) => `$${n + 1}`).join(', ')})`,
            Object.values(row),
          ),
        );
      };
      expect(await insert({ reasons: ['price-cheap'] })).toBe('offer_post_reviews_reasons_check');
      expect(await insert({ reasons: [] })).toBe('offer_post_reviews_reasons_check');
      expect(await insert({ sample_percent: 5 })).toBe('offer_post_reviews_sample_check');
      expect(await insert({ reasons: ['sample'] })).toBe('offer_post_reviews_sample_check');
      expect(await insert({ reasons: ['sample'], sample_percent: 101 })).toBe(
        'offer_post_reviews_sample_check',
      );
      // An open row carries no decision and no note.
      expect(await insert({ note: 'x' })).toBe('offer_post_reviews_decided_check');
      expect(await insert({ market_id: 'au' })).not.toBeNull();
    });

    it('keeps the reasons insert-only, with a record id or an Offer version as the source', async () => {
      const { offerId, productId } = await liveOffer();
      const review = opened(offerId, productId);
      await unit(() => reviews.insert(market, review));
      const receive = (sourceRef: string) =>
        owner.query(
          `INSERT INTO catalog.offer_post_review_reasons (market_id, tenant_id, offer_id, reason,
             source_ref, post_review_id, received_at)
           VALUES ($1, $2, $3, 'price-no-reference', $4, $5, now())`,
          [code, market.tenantId, offerId, sourceRef, review.state.id],
        );
      await receive(uuid7());
      await receive('offer-version:3');
      await expect(receive('some text')).rejects.toThrow();
      await expect(
        owner.query(`DELETE FROM catalog.offer_post_review_reasons WHERE offer_id = $1`, [offerId]),
      ).rejects.toThrow();
      await expect(
        owner.query(
          `UPDATE catalog.offer_post_review_reasons SET reason = 'sample' WHERE offer_id = $1`,
          [offerId],
        ),
      ).rejects.toThrow();
    });

    it('grants the app role insert, select and the decision columns only', async () => {
      const rows = await owner.query(
        `SELECT has_table_privilege('mondapac_app', 'catalog.offer_post_reviews', 'DELETE') AS delete,
              has_table_privilege('mondapac_app', 'catalog.offer_post_reviews', 'TRUNCATE') AS truncate,
              has_column_privilege('mondapac_app', 'catalog.offer_post_reviews', 'status', 'UPDATE') AS status,
              has_column_privilege('mondapac_app', 'catalog.offer_post_reviews', 'note', 'UPDATE') AS note,
              has_column_privilege('mondapac_app', 'catalog.offer_post_reviews', 'offer_id', 'UPDATE') AS offer,
              has_column_privilege('mondapac_app', 'catalog.offer_post_reviews', 'opened_at', 'UPDATE') AS opened,
              has_table_privilege('mondapac_app', 'catalog.offer_post_review_reasons', 'UPDATE') AS reason_update,
              has_table_privilege('mondapac_app', 'catalog.offer_post_review_reasons', 'INSERT') AS reason_insert`,
      );
      expect(rows.rows).toEqual([
        {
          delete: false,
          truncate: false,
          status: true,
          note: true,
          offer: false,
          opened: false,
          reason_update: false,
          reason_insert: true,
        },
      ]);
    });

    it('takes an Offer down end to end: off sale, the held edit superseded taken-down, the row decided', async () => {
      const { offerId, productId } = await liveOffer();
      const review = opened(offerId, productId);
      await unit(() => reviews.insert(market, review));
      const pendingChanges = new PrismaOfferPendingChangeRepository(persistence.service);
      const proposed = OfferPendingChange.propose({
        id: uuid7() as Id<'OfferPendingChange'>,
        marketId: market.marketId,
        offerId,
        sellerId,
        baseOfferVersion: 3,
        proposedHandling: 'REPACKED',
        reasons: ['handling'],
        policyVersion: 4,
        submittedByAccountId: sellerAccount,
        now: T0,
      });
      if (!proposed.ok) throw new Error(proposed.error.code);
      await unit(() => pendingChanges.insert(market, proposed.value));
      const adminAccount = uuid7() as Id<'Account'>;
      const context = testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'admin',
          accountId: adminAccount,
          sessionId: uuid7() as Id<'Session'>,
          sellerId: null,
        }),
      );
      const takeDown = new AdminOfferPostReviewTakeDown(gate, {
        unitOfWork: persistence.unitOfWork,
        postReviews: reviews,
        offers,
        pendingChanges,
        editReview: prismaOfferEditReview(persistence.service, ids, NO_AUDIT),
        probation: memoryProbation().probation,
        audit: NO_AUDIT,
        outbox: new RecordingOutbox(),
        clock: new FixedClock(nowInstant()),
      });
      // The seller's own submit is the seller's account, not this admin's.
      expect(await read(() => reviews.submitterAccountIds(market, offerId))).toEqual(
        new Set([sellerAccount]),
      );
      const outcome = await takeDown.execute(context, {
        id: review.state.id,
        version: 1,
        reasonCode: 'handling-unclear',
        misconduct: false,
        note: 'The handling does not match the photos',
      });
      expect(outcome).toMatchObject({ ok: true, value: { status: 'taken-down', version: 2 } });
      const state = await owner.query(
        `SELECT o.status AS offer, o.listed, r.status AS review, r.decision_reason_code, c.status AS change,
                c.superseded_cause
         FROM catalog.offers o
         JOIN catalog.offer_post_reviews r ON r.market_id = o.market_id AND r.offer_id = o.id
         JOIN catalog.offer_pending_changes c ON c.market_id = o.market_id AND c.offer_id = o.id
         WHERE o.market_id = $1 AND o.id = $2`,
        [code, offerId],
      );
      expect(state.rows).toEqual([
        {
          offer: 'changes-needed',
          listed: false,
          review: 'taken-down',
          decision_reason_code: 'handling-unclear',
          change: 'superseded',
          superseded_cause: 'taken-down',
        },
      ]);
      // R6: the resubmit of this Offer reads it was taken down; another Market never does.
      expect(await read(() => reviews.everTakenDown(market, offerId))).toBe(true);
      const foreign = await persistence.unitOfWork.run(other, async () => ({
        ok: true as const,
        value: await reviews.everTakenDown(other, offerId),
      }));
      expect(foreign).toEqual({ ok: true, value: false });
    });

    it('lists and counts by status, reason and seller, oldest first, in the Market only', async () => {
      const { offerId, productId } = await liveOffer();
      const review = opened(offerId, productId, 'sample');
      await unit(() => reviews.insert(market, review));
      const listed = await read(() =>
        reviews.list(
          market,
          { sort: 'opened', direction: 'asc', offset: 0, limit: 500 },
          { status: 'open', reasons: ['sample'], sellerId },
        ),
      );
      expect(listed.map((row) => row.state.id)).toContain(review.state.id);
      for (const row of listed) {
        expect(row.state).toMatchObject({ marketId: code, status: 'open', sellerId });
        expect(row.state.reasons).toContain('sample');
      }
      expect(await read(() => reviews.sellerIds(market, 'open', 100))).toContain(sellerId);
      const foreign = await persistence.unitOfWork.run(other, async () => ({
        ok: true as const,
        value: await reviews.list(
          other,
          { sort: 'opened', direction: 'asc', offset: 0, limit: 500 },
          { sellerId },
        ),
      }));
      expect(foreign).toEqual({ ok: true, value: [] });
    });
  },
);
