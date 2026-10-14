import { Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { Offer } from '../../src/modules/catalog/domain/offer';
import { Product } from '../../src/modules/catalog/domain/product';
import { simpleProductType } from '../../src/modules/catalog/domain/product-types/simple';
import { PrismaOfferRepository } from '../../src/modules/catalog/infrastructure/prisma-offer.repository';
import { PrismaProductRepository } from '../../src/modules/catalog/infrastructure/prisma-product.repository';
import { TEST_MARKETS } from '../support/test-config';
import { createPersistence, marketOf, type Persistence } from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';

// Catalog Offer review (submit, approve, request changes, delete): PrismaOfferRepository.save and
// listPendingReview on PostgreSQL, for both Market fixtures. The table's own checks (handling
// from the submit on, listed only when published, deleted_at exactly when deleted) accept what the
// aggregate writes, each change leaves one history row, and the queue is oldest submit first.

const T0 = Temporal.Instant.from('2026-10-14T00:00:00Z');
const T1 = T0.add({ hours: 1 });
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const ids = { next: <K extends string>() => uuid7() as Id<K> };

describe.each(TEST_MARKETS)(
  'catalog Offer review repository in market %s (database integration)',
  (code) => {
    const market = marketOf(code);
    let persistence: Persistence;
    let owner: Client;
    let products: PrismaProductRepository;
    let offers: PrismaOfferRepository;
    const sellerId = uuid7() as Id<'Seller'>;
    const seller = { kind: 'seller' as const, accountId: uuid7() as Id<'Account'> };
    const admin = { kind: 'admin' as const, accountId: uuid7() as Id<'Account'> };

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

    /** A draft Offer with handling (set straight in the table: its own command comes later). */
    async function draftOffer(sku = `S-${uuid7().slice(-12)}`): Promise<Id<'Offer'>> {
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
        sellerSku: sku,
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
      await owner.query(
        `UPDATE catalog.offers SET handling = 'SEALED_ORIGINAL' WHERE market_id = $1 AND id = $2`,
        [code, created.value.state.id],
      );
      return created.value.state.id;
    }

    const load = async (id: Id<'Offer'>) => {
      const found = await persistence.unitOfWork.run(market, async () => ({
        ok: true as const,
        value: await offers.findById(market, id),
      }));
      if (!found.ok || found.value === null) throw new Error('not found');
      return found.value;
    };
    const save = (offer: Offer, actor = seller) =>
      persistence.unitOfWork.run(market, async () => ({
        ok: true as const,
        value: await offers.save(market, offer, actor),
      }));
    const row = async (id: Id<'Offer'>) =>
      (
        await owner.query(
          `SELECT status, listed, version, submitted_at, first_published_at, deleted_at
             FROM catalog.offers WHERE market_id = $1 AND id = $2`,
          [code, id],
        )
      ).rows[0] as {
        status: string;
        listed: boolean;
        version: number;
        submitted_at: Date | null;
        first_published_at: Date | null;
        deleted_at: Date | null;
      };
    const history = async (id: Id<'Offer'>) =>
      (
        await owner.query(
          `SELECT change_kind, actor_kind, status FROM catalog.offer_history
            WHERE market_id = $1 AND offer_id = $2 ORDER BY offer_version`,
          [code, id],
        )
      ).rows as { change_kind: string; actor_kind: string; status: string }[];
    /** Submit as the seller with approval required: the Offer waits at `at`. */
    async function submitted(at: Temporal.Instant): Promise<Id<'Offer'>> {
      const id = await draftOffer();
      const offer = await load(id);
      offer.submit({ approvalRequired: true, now: at });
      await save(offer);
      return id;
    }

    it('stores a submit that waits for review: pending, stamped, one submitted history row', async () => {
      const id = await draftOffer();
      const offer = await load(id);
      expect(offer.submit({ approvalRequired: true, now: T1 }).ok).toBe(true);
      expect(await save(offer)).toEqual({ ok: true, value: null });
      expect(await row(id)).toMatchObject({
        status: 'pending-first-publish',
        listed: false,
        version: 2,
        submitted_at: new Date(T1.epochMilliseconds),
        first_published_at: null,
      });
      expect(await history(id)).toEqual([
        { change_kind: 'created', actor_kind: 'seller', status: 'draft' },
        { change_kind: 'submitted', actor_kind: 'seller', status: 'pending-first-publish' },
      ]);
    });

    it('stores a submit that publishes at once: published, listed, first-published', async () => {
      const id = await draftOffer();
      const offer = await load(id);
      offer.submit({ approvalRequired: false, now: T1 });
      expect(await save(offer)).toEqual({ ok: true, value: null });
      expect(await row(id)).toMatchObject({
        status: 'published',
        listed: true,
        version: 2,
        first_published_at: new Date(T1.epochMilliseconds),
      });
      expect((await history(id)).at(-1)).toEqual({
        change_kind: 'published',
        actor_kind: 'seller',
        status: 'published',
      });
    });

    it('stores an approval by an admin: published and listed, history by the admin', async () => {
      const id = await submitted(T0);
      const offer = await load(id);
      expect(offer.approve({ now: T1 }).ok).toBe(true);
      expect(await save(offer, admin as never)).toEqual({ ok: true, value: null });
      expect(await row(id)).toMatchObject({
        status: 'published',
        listed: true,
        version: 3,
        submitted_at: new Date(T0.epochMilliseconds),
        first_published_at: new Date(T1.epochMilliseconds),
      });
      expect((await history(id)).at(-1)).toEqual({
        change_kind: 'publication-approved',
        actor_kind: 'admin',
        status: 'published',
      });
    });

    it('stores a request for changes as changes-needed, then a seller edit returns it to draft', async () => {
      const id = await submitted(T0);
      const offer = await load(id);
      offer.requestChanges({ reasonCode: 'other', now: T1 });
      await save(offer, admin as never);
      expect(await row(id)).toMatchObject({ status: 'changes-needed', version: 3 });
      const again = await load(id);
      again.edit({
        sellerSku: again.state.sellerSku,
        conditionCode: 'new',
        description: { 'en-AU': 'Better text' },
        now: T1,
      });
      await save(again);
      expect(await row(id)).toMatchObject({ status: 'draft', version: 4, submitted_at: null });
      expect((await history(id)).map((h) => h.change_kind)).toEqual([
        'created',
        'submitted',
        'changes-requested',
        'edited',
      ]);
    });

    it('stores a delete: deleted_at set, not listed, row and history kept, SKU free again', async () => {
      const sku = `D-${uuid7().slice(-12)}`;
      const id = await draftOffer(sku);
      const published = await load(id);
      published.submit({ approvalRequired: false, now: T0 });
      await save(published);
      const offer = await load(id);
      expect(offer.delete({ now: T1 }).ok).toBe(true);
      expect(await save(offer)).toEqual({ ok: true, value: null });
      expect(await row(id)).toMatchObject({
        status: 'deleted',
        listed: false,
        version: 3,
        deleted_at: new Date(T1.epochMilliseconds),
      });
      expect((await history(id)).at(-1)?.change_kind).toBe('deleted');
      // The SKU unique covers open Offers only: the seller can use the SKU again.
      await expect(draftOffer(sku)).resolves.toEqual(expect.any(String));
    });

    it('keeps a page anchor that has been decided since: the next page continues after it', async () => {
      const a = await submitted(T0.add({ minutes: 1 }));
      const b = await submitted(T0.add({ minutes: 2 }));
      const c = await submitted(T0.add({ minutes: 3 }));
      const first = await load(a);
      first.approve({ now: T1 });
      await save(first, admin as never);
      const page = await persistence.unitOfWork.run(
        market,
        async () => ({
          ok: true as const,
          value: await offers.listPendingReview(market, { afterId: a, limit: 500 }),
        }),
        { readOnly: true },
      );
      if (!page.ok) throw new Error('list failed');
      const order = page.value.map((o) => o.state.id).filter((x) => x === b || x === c);
      expect(order).toEqual([b, c]);
      expect(page.value.map((o) => o.state.id)).not.toContain(a);
    });

    it('lists the waiting Offers oldest submit first in keyset pages, and nothing else', async () => {
      const later = await submitted(T0.add({ minutes: 30 }));
      const earlier = await submitted(T0.add({ minutes: 10 }));
      const draft = await draftOffer();
      const mine = new Set<string>([later, earlier, draft]);
      const list = (afterId: Id<'Offer'> | null, limit: number) =>
        persistence.unitOfWork.run(
          market,
          async () => ({
            ok: true as const,
            value: await offers.listPendingReview(market, { afterId, limit }),
          }),
          { readOnly: true },
        );

      const all = await list(null, 500);
      if (!all.ok) throw new Error('list failed');
      const order = all.value.map((o) => o.state.id).filter((x) => mine.has(x));
      expect(order).toEqual([earlier, later]);
      expect(all.value.every((o) => o.state.status === 'pending-first-publish')).toBe(true);

      const first = await list(null, 1);
      const second = await list(first.ok ? first.value[0]!.state.id : null, 1);
      if (!first.ok || !second.ok) throw new Error('list failed');
      expect(first.value).toHaveLength(1);
      expect(second.value[0]?.state.id).not.toBe(first.value[0]!.state.id);
    });
  },
);
