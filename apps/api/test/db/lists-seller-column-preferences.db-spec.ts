import { parseId, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { ok } from '@mondapac/shared-kernel';
import type { StoredColumnPreference } from '../../src/modules/lists/contracts';
import { PrismaColumnPreferenceStore } from '../../src/modules/lists/infrastructure/prisma-column-preference-store';
import { TEST_MARKETS } from '../support/test-config';
import { createPersistence, marketOf, type Persistence } from './persistence-support';

// Seller column choices on PostgreSQL as the application role (super list B0-2, seller side): a
// store-scoped list keeps one row per store, an account-scoped list one row with no store, and a
// second save of the same scope replaces the first.

const T0 = Temporal.Instant.from('2026-11-18T00:00:00Z');
const PRODUCTS = 'seller.catalog.products';
const ORDERS = 'seller.ordering.orders';
let counter = 0;
const idOf = <T extends string>(): Id<T> => {
  const parsed = parseId<T>(
    uuidV7(Date.now() + counter++, crypto.getRandomValues(new Uint8Array(10))),
  );
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value;
};

describe.each(TEST_MARKETS)('lists seller column preferences in market %s (database)', (code) => {
  const market = marketOf(code);
  let db: Persistence;
  let store: PrismaColumnPreferenceStore;
  const storeA = idOf<'Seller'>();
  const storeB = idOf<'Seller'>();

  beforeAll(() => {
    db = createPersistence();
    store = new PrismaColumnPreferenceStore(db.service);
  });
  afterAll(async () => {
    await db.close();
  });

  const preference = (
    listKey: string,
    sellerId: Id<'Seller'> | null,
    ownerAccountId: Id<'Account'>,
    columns: readonly string[],
  ): StoredColumnPreference => ({
    id: idOf<'ColumnPreference'>(),
    listKey,
    ownerAccountId,
    sellerId,
    columns,
    createdAt: T0,
    updatedAt: T0,
  });
  const within = <T>(work: () => Promise<T>) =>
    db.unitOfWork.run(market, async () => ok(await work()), { isolation: 'serializable' });

  it('keeps a store-scoped choice per store and replaces it on a second save', async () => {
    const account = idOf<'Account'>();
    await within(() => store.put(market, preference(PRODUCTS, storeA, account, ['code'])));
    await within(() =>
      store.put(market, preference(PRODUCTS, storeA, account, ['offers', 'code'])),
    );
    const inA = await within(() => store.find(market, storeA, PRODUCTS, account));
    const inB = await within(() => store.find(market, storeB, PRODUCTS, account));
    expect(inA.ok && inA.value?.columns).toEqual(['offers', 'code']);
    expect(inB.ok && inB.value).toBeNull();
    await within(() => store.remove(market, storeA, PRODUCTS, account));
    const gone = await within(() => store.find(market, storeA, PRODUCTS, account));
    expect(gone.ok && gone.value).toBeNull();
  });

  it('keeps an account-scoped choice with no store, once per account', async () => {
    const account = idOf<'Account'>();
    await within(() => store.put(market, preference(ORDERS, null, account, ['paid'])));
    await within(() => store.put(market, preference(ORDERS, null, account, ['total', 'paid'])));
    const own = await within(() => store.find(market, null, ORDERS, account));
    const other = await within(() => store.find(market, null, ORDERS, idOf<'Account'>()));
    expect(own.ok && own.value?.columns).toEqual(['total', 'paid']);
    expect(other.ok && other.value).toBeNull();
  });
});
