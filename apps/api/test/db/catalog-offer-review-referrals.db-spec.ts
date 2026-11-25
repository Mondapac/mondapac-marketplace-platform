import { Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import type { OfferReviewReferral } from '../../src/modules/catalog/application/ports/offer-review';
import { Offer } from '../../src/modules/catalog/domain/offer';
import { Product } from '../../src/modules/catalog/domain/product';
import { simpleProductType } from '../../src/modules/catalog/domain/product-types/simple';
import { PrismaOfferRepository } from '../../src/modules/catalog/infrastructure/prisma-offer.repository';
import { PrismaOfferReviewReferralStore } from '../../src/modules/catalog/infrastructure/prisma-offer-review-referral.store';
import { PrismaProductRepository } from '../../src/modules/catalog/infrastructure/prisma-product.repository';
import { TEST_MARKETS } from '../support/test-config';
import { createPersistence, marketOf, type Persistence } from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';

// The Offer review policy's decisions (ADR-0051): PrismaOfferReviewReferralStore on PostgreSQL, for
// both Market fixtures. A decision is stored with its reasons and policy version; the table is
// insert-only, takes only the policy's reason codes and binds the row to the Offer's own seller.

const T0 = Temporal.Instant.from('2026-11-25T00:00:00Z');
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const ids = { next: <K extends string>() => uuid7() as Id<K> };

describe.each(TEST_MARKETS)(
  'catalog Offer review referrals in market %s (database integration)',
  (code) => {
    const market = marketOf(code);
    let persistence: Persistence;
    let owner: Client;
    let products: PrismaProductRepository;
    let offers: PrismaOfferRepository;
    let store: PrismaOfferReviewReferralStore;
    const sellerId = uuid7() as Id<'Seller'>;
    const seller = { kind: 'seller' as const, accountId: uuid7() as Id<'Account'> };

    beforeAll(async () => {
      persistence = createPersistence();
      owner = new Client({ connectionString: ownerTestDatabaseUrl() });
      await owner.connect();
      products = new PrismaProductRepository(persistence.service);
      offers = new PrismaOfferRepository(persistence.service, ids);
      store = new PrismaOfferReviewReferralStore(persistence.service, ids);
    });
    afterAll(async () => {
      await owner.end();
      await persistence.close();
    });

    async function draftOffer(): Promise<Id<'Offer'>> {
      const product = Product.create({
        id: uuid7() as Id<'Product'>,
        marketId: market.marketId,
        scope: 'PLATFORM',
        sellerId: null,
        handler: simpleProductType,
        familyCode: 'default',
        productCode: `R${uuid7().replaceAll('-', '').slice(-12).toUpperCase()}`,
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
      const res = await persistence.unitOfWork.run(market, async () => {
        await products.add(market, product.value);
        return { ok: true as const, value: await offers.add(market, created.value, seller) };
      });
      if (!res.ok || res.value !== null) throw new Error('add failed');
      return created.value.state.id;
    }

    const record = (referral: OfferReviewReferral) =>
      persistence.unitOfWork.run(market, async () => {
        await store.record(market, referral);
        return { ok: true as const, value: null };
      });
    const referral = (offerId: Id<'Offer'>, overrides: Partial<OfferReviewReferral> = {}) => ({
      offerId,
      sellerId,
      offerVersion: 2,
      trigger: 'first-publication' as const,
      reasons: ['probation', 'handling'] as const,
      policyVersion: 1,
      decidedAt: T0,
      ...overrides,
    });

    it('stores a decision with its reasons and policy version, and an empty one for a publish', async () => {
      const offerId = await draftOffer();
      await record(referral(offerId));
      await record(referral(offerId, { reasons: [], offerVersion: 3 }));
      const rows = await owner.query(
        `SELECT seller_id, offer_version, trigger, reasons, policy_version, tenant_id
           FROM catalog.offer_review_referrals WHERE market_id = $1 AND offer_id = $2
          ORDER BY offer_version`,
        [code, offerId],
      );
      expect(rows.rows).toEqual([
        {
          seller_id: sellerId,
          offer_version: 2,
          trigger: 'first-publication',
          reasons: ['probation', 'handling'],
          policy_version: 1,
          tenant_id: market.tenantId,
        },
        expect.objectContaining({ offer_version: 3, reasons: [] }),
      ]);
    });

    it('keeps one decision per Offer version and trigger (a retried insert fails)', async () => {
      const offerId = await draftOffer();
      await record(referral(offerId));
      await expect(record(referral(offerId, { reasons: [] }))).rejects.toThrow();
    });

    it('is insert-only, even for the owner', async () => {
      const offerId = await draftOffer();
      await record(referral(offerId));
      await expect(
        owner.query(
          `UPDATE catalog.offer_review_referrals SET reasons = '{}' WHERE offer_id = $1`,
          [offerId],
        ),
      ).rejects.toThrow();
      await expect(
        owner.query(`DELETE FROM catalog.offer_review_referrals WHERE offer_id = $1`, [offerId]),
      ).rejects.toThrow();
    });

    it('refuses an unknown reason, another seller and an unknown trigger', async () => {
      const offerId = await draftOffer();
      await expect(record(referral(offerId, { reasons: ['cheap'] as never }))).rejects.toThrow();
      await expect(
        record(referral(offerId, { sellerId: uuid7() as Id<'Seller'> })),
      ).rejects.toThrow();
      await expect(record(referral(offerId, { trigger: 'resubmit' as never }))).rejects.toThrow();
    });
  },
);
