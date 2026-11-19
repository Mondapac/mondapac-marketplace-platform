import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import type { ShelfActor } from '../../src/modules/catalog/application/ports/seller-category.store';
import { PlatformCategory } from '../../src/modules/catalog/domain/platform-category';
import { Product } from '../../src/modules/catalog/domain/product';
import { configurableProductType } from '../../src/modules/catalog/domain/product-types/configurable';
import { PrismaPlatformCategoryRepository } from '../../src/modules/catalog/infrastructure/prisma-platform-category.repository';
import { PrismaProductRepository } from '../../src/modules/catalog/infrastructure/prisma-product.repository';
import { PrismaSellerCategoryStore } from '../../src/modules/catalog/infrastructure/prisma-seller-category.store';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';

// The seller category store on PostgreSQL, for both Market fixtures (categories C9a; data design
// 3.22, 3.13): one waiting proposal per (seller, parent, normalised name); a decision only from
// `pending` at the version read, once; the revocation cancels the seller's pending proposals
// only; the admin queue oldest first by keyset; a shelf's slug unique per seller; a shelf on an
// Offer only from the Offer's own seller (composite key); clearing a shelf raises each Offer's
// version with a `shelf-cleared` history row; the guard triggers; and the Market boundary.

const T0 = Temporal.Instant.from('2026-11-06T10:00:00Z');
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const ADMIN = uuid7() as Id<'Account'>;
const SELLER_ACTOR: ShelfActor = { kind: 'seller', accountId: ADMIN, actingAdminAccountId: null };

describe.each(TEST_MARKETS)('catalog seller category store in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let db: Persistence;
  let owner: Client;
  let store: PrismaSellerCategoryStore;

  beforeAll(async () => {
    db = createPersistence();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
    store = new PrismaSellerCategoryStore(db.service, { next: () => uuid7() } as never);
  });
  afterAll(async () => {
    await owner.end();
    await db.close();
  });

  const run = async <T>(target: typeof market, work: () => Promise<T>) => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()));
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };

  async function platformCategory(target: typeof market): Promise<Id<'Category'>> {
    const created = PlatformCategory.create({
      id: uuid7() as Id<'Category'>,
      revisionId: uuid7() as Id<'CategoryRevision'>,
      marketId: target.marketId,
      parentId: null,
      verticalRootCode: null,
      slug: `sc-${uuid7().slice(-10)}`,
      names: [{ locale: 'en-AU', name: 'Pantry' }],
      createdByKind: 'seed',
      now: T0,
    });
    if (!created.ok) throw new Error(created.error.code);
    await run(target, () =>
      new PrismaPlatformCategoryRepository(db.service).add(target, created.value),
    );
    return created.value.state.id;
  }

  async function offer(target: typeof market, sellerId: string): Promise<Id<'Offer'>> {
    const created = Product.create({
      id: uuid7() as Id<'Product'>,
      marketId: target.marketId,
      scope: 'PLATFORM',
      sellerId: null,
      handler: configurableProductType,
      familyCode: 'default',
      productCode: `P${uuid7().replaceAll('-', '').slice(-12).toUpperCase()}`,
      variantId: null,
      now: T0,
    });
    if (!created.ok) throw new Error(created.error.code);
    await run(target, () => new PrismaProductRepository(db.service).add(target, created.value));
    const id = uuid7();
    await owner.query(
      `INSERT INTO catalog.offers (id, market_id, tenant_id, seller_id, product_id, seller_sku,
         condition_code, description, handling, attestation_recorded_at, attestation_account_id,
         status, off_sale_type_not_allowed, off_sale_product_retired, off_sale_product_not_listed,
         off_sale_product_paused, off_sale_tag_suspended, off_sale_description_claim_text, listed,
         submitted_at, first_published_at, version, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'new','{"en":"x"}','SEALED_ORIGINAL',$7,$8,'published',
         false,false,false,false,false,false,true,$7,$7,1,$7)`,
      [
        id,
        target.marketId,
        target.tenantId,
        sellerId,
        created.value.state.id,
        `SKU-${id.slice(-8)}`,
        T0.toString(),
        uuid7(),
      ],
    );
    return id as Id<'Offer'>;
  }

  const propose = (
    target: typeof market,
    sellerId: string,
    parentId: Id<'Category'>,
    name: string,
    at = T0,
  ) => {
    const id = uuid7() as Id<'CategoryProposal'>;
    return run(target, async () => ({
      id,
      added: await store.addProposal(target, {
        id,
        sellerId: sellerId as Id<'Seller'>,
        platformParentId: parentId,
        texts: [{ locale: 'en-AU', name, description: 'About it' }],
        normalisedName: name.toLowerCase(),
        now: at,
      }),
    }));
  };
  const shelf = async (
    target: typeof market,
    sellerId: string,
    parentId: Id<'Category'>,
    slug: string,
  ) => {
    const id = uuid7() as Id<'SellerCategory'>;
    await run(target, () =>
      store.insertShelf(target, {
        id,
        sellerId: sellerId as Id<'Seller'>,
        platformParentId: parentId,
        slug,
        texts: [{ locale: 'en-AU', name: 'Spices', description: null }],
        now: T0,
      }),
    );
    return id;
  };

  it('keeps one waiting proposal per seller, parent and normalised name', async () => {
    const parent = await platformCategory(market);
    const seller = uuid7();
    const first = await propose(market, seller, parent, 'Dried Fruit');
    expect(first.added).toBeNull();
    expect((await propose(market, seller, parent, 'Dried Fruit')).added).toBe('proposal.duplicate');
    // Another seller, and the same seller once the first is no longer pending, may propose it.
    expect((await propose(market, uuid7(), parent, 'Dried Fruit')).added).toBeNull();
    expect(
      await run(market, () =>
        store.decideProposal(
          market,
          first.id,
          1,
          { status: 'cancelled', reason: 'seller-cancelled' },
          T0,
        ),
      ),
    ).toBe(true);
    expect((await propose(market, seller, parent, 'Dried Fruit')).added).toBeNull();
    expect(await run(market, () => store.pendingCount(market, seller as Id<'Seller'>))).toBe(1);
    const view = await run(market, () => store.findProposal(market, first.id));
    expect(view).toMatchObject({
      status: 'cancelled',
      reasonCode: 'seller-cancelled',
      version: 2,
      texts: [{ locale: 'en-AU', name: 'Dried Fruit', description: 'About it' }],
    });
  });

  it('decides a proposal only from pending at the version read, once', async () => {
    const parent = await platformCategory(market);
    const seller = uuid7();
    const { id } = await propose(market, seller, parent, 'Teas');
    const reject = { status: 'rejected', by: ADMIN, reason: 'too-narrow' } as const;
    expect(await run(market, () => store.decideProposal(market, id, 2, reject, T0))).toBe(false);
    expect(await run(market, () => store.decideProposal(market, id, 1, reject, T0))).toBe(true);
    expect(await run(market, () => store.decideProposal(market, id, 2, reject, T0))).toBe(false);
    // The guard trigger refuses even an owner's second decision or a change of the names.
    await expect(
      owner.query(
        `UPDATE catalog.category_proposals SET status = 'cancelled', reason_code = 'seller-cancelled',
           decided_by_account_id = NULL, version = version + 1 WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow(/only a pending proposal is decided/);
    await expect(
      owner.query(`DELETE FROM catalog.category_proposals WHERE id = $1`, [id]),
    ).rejects.toThrow(/DELETE is not allowed/);
  });

  it('cancels every pending proposal of one seller on revocation, oldest first', async () => {
    const parent = await platformCategory(market);
    const seller = uuid7();
    const a = await propose(market, seller, parent, 'Alpha', T0);
    const b = await propose(market, seller, parent, 'Beta', T0.add({ seconds: 1 }));
    const kept = await propose(market, uuid7(), parent, 'Alpha');
    const cancelled = await run(market, () =>
      store.cancelPendingOfSeller(market, seller as Id<'Seller'>, 'permission-revoked', T0),
    );
    expect(cancelled).toEqual([
      { id: a.id, version: 2 },
      { id: b.id, version: 2 },
    ]);
    expect((await run(market, () => store.findProposal(market, kept.id)))?.status).toBe('pending');
    expect((await run(market, () => store.findProposal(market, a.id)))?.reasonCode).toBe(
      'permission-revoked',
    );
  });

  it('pages the waiting proposals oldest first and never shows another Market’s', async () => {
    const parent = await platformCategory(market);
    const foreignParent = await platformCategory(other);
    const at = T0.add({ hours: 100 + sequence });
    const one = await propose(market, uuid7(), parent, 'One', at);
    const two = await propose(market, uuid7(), parent, 'Two', at.add({ seconds: 1 }));
    const foreign = await propose(other, uuid7(), foreignParent, 'One', at);
    const all = await run(market, () => store.listPending(market, { after: null, limit: 1000 }));
    const ids = all.map((view) => view.id);
    expect(ids.indexOf(one.id)).toBeLessThan(ids.indexOf(two.id));
    expect(ids).not.toContain(foreign.id);
    const after = await run(market, () =>
      store.listPending(market, { after: one.id, limit: 1000 }),
    );
    expect(after.map((view) => view.id)).toContain(two.id);
    expect(after.map((view) => view.id)).not.toContain(one.id);
    expect(await run(market, () => store.findProposal(market, foreign.id))).toBeNull();
  });

  it('keeps a shelf slug unique per seller and links an approved proposal to its shelf', async () => {
    const parent = await platformCategory(market);
    const seller = uuid7();
    const { id } = await propose(market, seller, parent, 'spices');
    const shelfId = await shelf(market, seller, parent, 'spices');
    expect(await run(market, () => store.slugTaken(market, seller as Id<'Seller'>, 'spices'))).toBe(
      true,
    );
    expect(
      await run(market, () => store.slugTaken(market, uuid7() as Id<'Seller'>, 'spices')),
    ).toBe(false);
    await expect(shelf(market, seller, parent, 'spices')).rejects.toThrow();
    expect(
      await run(market, () =>
        store.decideProposal(market, id, 1, { status: 'approved', by: ADMIN, shelfId }, T0),
      ),
    ).toBe(true);
    expect(
      await run(market, () =>
        store.activeShelfNamed(market, seller as Id<'Seller'>, parent, 'spices'),
      ),
    ).toBe(true);
    const shelves = await run(market, () => store.shelvesOfSeller(market, seller as Id<'Seller'>));
    expect(shelves).toMatchObject([{ id: shelfId, status: 'active', slug: 'spices', version: 1 }]);
    expect(await run(other, () => store.findShelf(other, shelfId))).toBeNull();
  });

  it('puts a shelf only on an Offer of the same seller, and clears it with a history row', async () => {
    const parent = await platformCategory(market);
    const seller = uuid7();
    const otherSeller = uuid7();
    const shelfId = await shelf(market, seller, parent, `s-${uuid7().slice(-8)}`);
    const own = await offer(market, seller);
    const foreign = await offer(market, otherSeller);
    const change = (offerId: Id<'Offer'>, sellerId: string, version: number) =>
      run(market, () =>
        store.setOfferShelf(market, {
          offerId,
          sellerId: sellerId as Id<'Seller'>,
          shelfId,
          expectedVersion: version,
          actor: SELLER_ACTOR,
          now: T0,
        }),
      );
    expect(await change(own, seller, 1)).toEqual({ version: 2 });
    expect(await change(own, seller, 1)).toBe('conflict.stale');
    expect(await change(foreign, seller, 1)).toBe('offer.not-found');
    // Even past the store, the composite key refuses another seller's shelf on an Offer.
    await expect(
      owner.query(`UPDATE catalog.offers SET shelf_category_id = $1 WHERE id = $2`, [
        shelfId,
        foreign,
      ]),
    ).rejects.toThrow(/offers_market_id_shelf_category_id_seller_id_fkey/);

    expect(
      await run(market, () =>
        store.closeShelf(market, shelfId, 1, { status: 'merged', into: parent }),
      ),
    ).toBe(true);
    const cleared = await run(market, () =>
      store.clearShelfOnOffers(
        market,
        shelfId,
        { kind: 'admin', accountId: ADMIN, actingAdminAccountId: null },
        T0,
      ),
    );
    expect(cleared).toBe(1);
    const row = await owner.query<{ shelf_category_id: string | null; version: number }>(
      `SELECT shelf_category_id, version FROM catalog.offers WHERE id = $1`,
      [own],
    );
    expect(row.rows).toEqual([{ shelf_category_id: null, version: 3 }]);
    const history = await owner.query<{ change_kind: string; offer_version: number }>(
      `SELECT change_kind, offer_version FROM catalog.offer_history WHERE offer_id = $1
         ORDER BY offer_version`,
      [own],
    );
    expect(history.rows.map((entry) => entry.change_kind).slice(-2)).toEqual([
      'edited',
      'shelf-cleared',
    ]);
  });

  it("serialises one seller's shelf units on the seller lock: a set-shelf waits for a close and sees it (Mojtaba B2)", async () => {
    const parent = await platformCategory(market);
    const seller = uuid7();
    const shelfId = await shelf(market, seller, parent, `s-${uuid7().slice(-8)}`);
    const steps: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let lockedA!: () => void;
    const aHoldsLock = new Promise<void>((resolve) => (lockedA = resolve));
    const close = run(market, async () => {
      await store.lockSeller(market, seller as Id<'Seller'>);
      lockedA();
      await gate;
      steps.push('close');
      return store.closeShelf(market, shelfId, 1, { status: 'merged', into: parent });
    });
    await aHoldsLock;
    const setShelf = run(market, async () => {
      await store.lockSeller(market, seller as Id<'Seller'>);
      steps.push('set-shelf');
      return store.findShelf(market, shelfId);
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(steps).toEqual([]);
    release();
    expect(await close).toBe(true);
    expect((await setShelf)?.status).toBe('merged');
    expect(steps).toEqual(['close', 'set-shelf']);
  });

  it('clears a closed shelf from every Offer, also one edited since it was read (Mojtaba B2)', async () => {
    const parent = await platformCategory(market);
    const seller = uuid7();
    const shelfId = await shelf(market, seller, parent, `s-${uuid7().slice(-8)}`);
    const first = await offer(market, seller);
    const second = await offer(market, seller);
    const put = (offerId: Id<'Offer'>, version: number, to: Id<'SellerCategory'> | null) =>
      run(market, () =>
        store.setOfferShelf(market, {
          offerId,
          sellerId: seller as Id<'Seller'>,
          shelfId: to,
          expectedVersion: version,
          actor: SELLER_ACTOR,
          now: T0,
        }),
      );
    expect(await put(first, 1, shelfId)).toEqual({ version: 2 });
    expect(await put(second, 1, shelfId)).toEqual({ version: 2 });
    // Another edit raises the second Offer's version; the clear must not skip it.
    expect(await put(second, 2, shelfId)).toEqual({ version: 3 });
    expect(
      await run(market, () =>
        store.closeShelf(market, shelfId, 1, { status: 'merged', into: parent }),
      ),
    ).toBe(true);
    const cleared = await run(market, () =>
      store.clearShelfOnOffers(
        market,
        shelfId,
        { kind: 'admin', accountId: ADMIN, actingAdminAccountId: null },
        T0,
      ),
    );
    expect(cleared).toBe(2);
    const rows = await owner.query<{
      id: string;
      shelf_category_id: string | null;
      version: number;
    }>(`SELECT id, shelf_category_id, version FROM catalog.offers WHERE id = ANY($1) ORDER BY id`, [
      [first, second],
    ]);
    expect(rows.rows).toEqual(
      [
        { id: first, shelf_category_id: null, version: 3 },
        { id: second, shelf_category_id: null, version: 4 },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
    const history = await owner.query<{ offer_id: string; offer_version: number }>(
      `SELECT offer_id, offer_version FROM catalog.offer_history
         WHERE offer_id = ANY($1) AND change_kind = 'shelf-cleared' ORDER BY offer_id`,
      [[first, second]],
    );
    expect(history.rows).toEqual(
      [
        { offer_id: first, offer_version: 3 },
        { offer_id: second, offer_version: 4 },
      ].sort((a, b) => a.offer_id.localeCompare(b.offer_id)),
    );
  });

  it('closes a shelf once from active, and its guard refuses any later change', async () => {
    const parent = await platformCategory(market);
    const seller = uuid7();
    const shelfId = await shelf(market, seller, parent, `s-${uuid7().slice(-8)}`);
    expect(
      await run(market, () => store.closeShelf(market, shelfId, 2, { status: 'promoted' })),
    ).toBe(false);
    expect(
      await run(market, () => store.closeShelf(market, shelfId, 1, { status: 'promoted' })),
    ).toBe(true);
    expect(
      await run(market, () => store.closeShelf(market, shelfId, 2, { status: 'promoted' })),
    ).toBe(false);
    await expect(
      owner.query(
        `UPDATE catalog.seller_categories SET status = 'active', version = version + 1 WHERE id = $1`,
        [shelfId],
      ),
    ).rejects.toThrow(/a closed shelf never changes/);
    await expect(
      owner.query(`DELETE FROM catalog.seller_categories WHERE id = $1`, [shelfId]),
    ).rejects.toThrow(/DELETE is not allowed/);
    expect(await run(market, () => store.platformParentState(market, parent))).toEqual({
      status: 'active',
    });
    expect(await run(other, () => store.platformParentState(other, parent))).toBeNull();
  });
});
