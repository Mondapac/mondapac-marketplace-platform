import { Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';
import { Offer, type OfferState } from '../../src/modules/catalog/domain/offer';
import { Product } from '../../src/modules/catalog/domain/product';
import { simpleProductType } from '../../src/modules/catalog/domain/product-types/simple';
import { PrismaOfferRepository } from '../../src/modules/catalog/infrastructure/prisma-offer.repository';
import { PrismaProductRepository } from '../../src/modules/catalog/infrastructure/prisma-product.repository';
import { TEST_MARKETS } from '../support/test-config';
import { createPersistence, marketOf, type Persistence } from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';

// Catalog slice 7b-1 (own-offer.edit): PrismaOfferRepository.save on PostgreSQL, for both Market
// fixtures. The write is conditional on the version read, leaves one `edited` history row with the
// changed field ids, returns a pending Offer to draft, and answers a taken SKU without a trace.

const T0 = Temporal.Instant.from('2026-10-09T00:00:00Z');
const T1 = T0.add({ hours: 1 });
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const ids = { next: <K extends string>() => uuid7() as Id<K> };

describe.each(TEST_MARKETS)(
  'catalog own-offer edit repository in market %s (database integration)',
  (code) => {
    const market = marketOf(code);
    let persistence: Persistence;
    let owner: Client;
    let products: PrismaProductRepository;
    let offers: PrismaOfferRepository;
    const sellerId = uuid7() as Id<'Seller'>;
    const actor = { kind: 'seller' as const, accountId: uuid7() as Id<'Account'> };

    beforeAll(async () => {
      persistence = createPersistence();
      owner = new Client({ connectionString: ownerTestDatabaseUrl() });
      await owner.connect();
      products = new PrismaProductRepository(persistence.service);
      offers = new PrismaOfferRepository(persistence.service, ids);
    });
    afterAll(async () => {
      await owner.end();
      await persistence.close();
    });

    /** Stores a draft Offer (on its own product) and moves it to `status` straight in the table. */
    async function storedOffer(
      sku: string,
      status: OfferState['status'] = 'draft',
    ): Promise<Id<'Offer'>> {
      const product = Product.create({
        id: uuid7() as Id<'Product'>,
        marketId: market.marketId,
        scope: 'PLATFORM',
        sellerId: null,
        handler: simpleProductType,
        familyCode: 'default',
        productCode: `E${uuid7().replaceAll('-', '').slice(-12).toUpperCase()}`,
        variantId: uuid7() as Id<'Variant'>,
        now: T0,
      });
      if (!product.ok) throw new Error(product.error.code);
      const created = Offer.create({
        id: uuid7() as Id<'Offer'>,
        marketId: market.marketId,
        sellerId,
        productId: product.value.state.id,
        sellerSku: sku,
        conditionCode: 'new',
        description: { 'en-AU': 'First text' },
        now: T0,
      });
      if (!created.ok) throw new Error(created.error.code);
      const res = await persistence.unitOfWork.run(market, async () => {
        await products.add(market, product.value);
        return { ok: true as const, value: await offers.add(market, created.value, actor) };
      });
      if (!res.ok || res.value !== null) throw new Error('add failed');
      if (status !== 'draft') {
        await owner.query(
          `UPDATE catalog.offers SET status = $3, submitted_at = $4, handling = 'FRESH' WHERE market_id = $1 AND id = $2`,
          [code, created.value.state.id, status, T0.toString()],
        );
      }
      return created.value.state.id;
    }

    const load = async (id: Id<'Offer'>) => {
      const offer = await persistence.unitOfWork.run(market, async () => ({
        ok: true as const,
        value: await offers.findById(market, id),
      }));
      if (!offer.ok || offer.value === null) throw new Error('not found');
      return offer.value;
    };
    const edit = (offer: Offer, sellerSku: string, text = 'First text') => {
      const result = offer.edit({
        sellerSku,
        conditionCode: 'new',
        description: { 'en-AU': text },
        now: T1,
      });
      if (!result.ok) throw new Error(result.error.code);
      return result.value;
    };
    const save = (offer: Offer) =>
      persistence.unitOfWork.run(market, async () => ({
        ok: true as const,
        value: await offers.save(market, offer, actor),
      }));
    const row = async (id: Id<'Offer'>) =>
      (
        await owner.query(
          `SELECT seller_sku, description, status, submitted_at, version
             FROM catalog.offers WHERE market_id = $1 AND id = $2`,
          [code, id],
        )
      ).rows[0] as {
        seller_sku: string;
        description: Record<string, string>;
        status: string;
        submitted_at: Date | null;
        version: number;
      };
    const history = async (id: Id<'Offer'>) =>
      (
        await owner.query(
          `SELECT change_kind, changed_fields FROM catalog.offer_history
            WHERE market_id = $1 AND offer_id = $2 ORDER BY occurred_at, id`,
          [code, id],
        )
      ).rows as { change_kind: string; changed_fields: string[] }[];

    it('stores the changed content, raises the version and adds one edited history row', async () => {
      const id = await storedOffer(`E-${uuid7().slice(-10)}`);
      const offer = await load(id);
      const changed = edit(offer, `E2-${uuid7().slice(-10)}`, 'Second text');
      expect(changed).toEqual(['sellerSku', 'description']);
      const saved = await save(offer);
      expect(saved).toEqual({ ok: true, value: null });
      const after = await row(id);
      expect(after).toMatchObject({
        status: 'draft',
        version: 2,
        description: { 'en-AU': 'Second text' },
      });
      expect(await history(id)).toEqual([
        { change_kind: 'created', changed_fields: [] },
        { change_kind: 'edited', changed_fields: ['sellerSku', 'description'] },
      ]);
    });

    it.each(['pending-first-publish', 'changes-needed'] as const)(
      'returns a %s Offer to draft and clears submitted_at',
      async (status) => {
        const id = await storedOffer(`P-${uuid7().slice(-10)}`, status);
        const offer = await load(id);
        edit(offer, offer.state.sellerSku);
        expect(await save(offer)).toEqual({ ok: true, value: null });
        const after = await row(id);
        expect(after.status).toBe('draft');
        expect(after.submitted_at).toBeNull();
        expect(after.version).toBe(2);
        expect((await history(id)).at(-1)).toEqual({ change_kind: 'edited', changed_fields: [] });
      },
    );

    it('stores nothing for an unchanged draft', async () => {
      const id = await storedOffer(`N-${uuid7().slice(-10)}`);
      const offer = await load(id);
      expect(edit(offer, offer.state.sellerSku)).toEqual([]);
      expect(await save(offer)).toEqual({ ok: true, value: null });
      expect((await row(id)).version).toBe(1);
      expect(await history(id)).toHaveLength(1);
    });

    it('throws a stale error for a lost race and leaves the winner’s row and one history row', async () => {
      const id = await storedOffer(`R-${uuid7().slice(-10)}`);
      const first = await load(id);
      const second = await load(id);
      edit(first, `R1-${uuid7().slice(-10)}`);
      edit(second, `R2-${uuid7().slice(-10)}`);
      expect(await save(first)).toEqual({ ok: true, value: null });
      const winner = (await row(id)).seller_sku;
      await expect(save(second)).rejects.toBeInstanceOf(StaleAggregateError);
      expect((await row(id)).seller_sku).toBe(winner);
      expect(await history(id)).toHaveLength(2);
    });

    it('answers a SKU the seller already uses on another open Offer and leaves nothing behind', async () => {
      const taken = `T-${uuid7().slice(-10)}`;
      await storedOffer(taken);
      const id = await storedOffer(`T2-${uuid7().slice(-10)}`);
      const offer = await load(id);
      edit(offer, taken);
      const result = await persistence.unitOfWork.run(market, async () => {
        const refusal = await offers.save(market, offer, actor);
        return refusal === null
          ? { ok: true as const, value: null }
          : { ok: false as const, error: refusal };
      });
      expect(result).toEqual({ ok: false, error: 'offer.sku-taken' });
      expect((await row(id)).version).toBe(1);
      expect(await history(id)).toHaveLength(1);
    });
  },
);
