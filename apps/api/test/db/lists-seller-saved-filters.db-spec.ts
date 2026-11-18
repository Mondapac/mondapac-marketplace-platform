import { parseId, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { ok } from '@mondapac/shared-kernel';
import type { StoredFilter } from '../../src/modules/lists/contracts/saved-filter-store';
import { PrismaSavedFilterStore } from '../../src/modules/lists/infrastructure/prisma-saved-filter-store';
import { TEST_MARKETS } from '../support/test-config';
import { createPersistence, marketOf, type Persistence } from './persistence-support';

// Seller lists on the shared store (super list B0-1b, seller side) on PostgreSQL as the application
// role: a store-scoped list keeps its rows per store, an account-scoped one (seller orders) keeps
// them with no store, and the table's checks allow exactly that.

const T0 = Temporal.Instant.from('2026-11-17T00:00:00Z');
const PRODUCTS = 'seller.catalog.products';
const ORDERS = 'seller.ordering.orders';
let counter = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + counter++, crypto.getRandomValues(new Uint8Array(10)));
const idOf = <T extends string>(): Id<T> => {
  const parsed = parseId<T>(uuid7());
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value;
};

describe.each(TEST_MARKETS)('lists seller saved filters in market %s (database)', (code) => {
  const market = marketOf(code);
  let db: Persistence;
  let store: PrismaSavedFilterStore;
  const storeA = idOf<'Seller'>();
  const storeB = idOf<'Seller'>();

  beforeAll(() => {
    db = createPersistence();
    store = new PrismaSavedFilterStore(db.service);
  });
  afterAll(async () => {
    await db.close();
  });

  const filter = (
    listKey: string,
    sellerId: Id<'Seller'> | null,
    ownerAccountId: Id<'Account'>,
    visibility: 'me' | 'everyone' = 'me',
  ): StoredFilter => ({
    id: idOf<'SavedFilter'>(),
    listKey,
    ownerAccountId,
    sellerId,
    visibility,
    name: `Filter ${uuid7().slice(-10)}`,
    payload: { v: 1 },
    position: 1,
    createdAt: T0,
    updatedAt: T0,
  });
  const within = <T>(work: () => Promise<T>) =>
    db.unitOfWork.run(market, async () => ok(await work()), { isolation: 'serializable' });

  it('keeps a store-scoped filter and a filter shared with the store inside that store', async () => {
    const account = idOf<'Account'>();
    const mine = filter(PRODUCTS, storeA, account);
    const shared = filter(PRODUCTS, storeA, idOf<'Account'>(), 'everyone');
    await within(async () => {
      expect(await store.add(market, mine)).not.toBe('name-taken');
      expect(await store.add(market, shared)).not.toBe('name-taken');
    });
    const inA = await within(() => store.visibleTo(market, storeA, PRODUCTS, account));
    const inB = await within(() => store.visibleTo(market, storeB, PRODUCTS, account));
    expect(inA.ok && inA.value.map((row) => row.id).sort()).toEqual([mine.id, shared.id].sort());
    expect(inB.ok && inB.value).toEqual([]);
  });

  it('accepts an account-scoped seller order filter with no store, shown to the account only', async () => {
    const account = idOf<'Account'>();
    const row = filter(ORDERS, null, account);
    await within(async () => {
      expect(await store.add(market, row)).not.toBe('name-taken');
    });
    const own = await within(() => store.visibleTo(market, null, ORDERS, account));
    const other = await within(() => store.visibleTo(market, null, ORDERS, idOf<'Account'>()));
    expect(own.ok && own.value.map((r) => r.id)).toEqual([row.id]);
    expect(other.ok && other.value).toEqual([]);
  });

  it('refuses the seller Products list with no store, and a share of an account-scoped filter', async () => {
    const account = idOf<'Account'>();
    await expect(
      within(() => store.add(market, filter(PRODUCTS, null, account))),
    ).rejects.toThrow();
    await expect(
      within(() => store.add(market, filter(ORDERS, null, account, 'everyone'))),
    ).rejects.toThrow();
  });
});
