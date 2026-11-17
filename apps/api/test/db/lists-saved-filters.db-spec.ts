import { parseId, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { err, ok } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import type { StoredFilter } from '../../src/modules/lists/contracts/saved-filter-store';
import { PrismaSavedFilterStore } from '../../src/modules/lists/infrastructure/prisma-saved-filter-store';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// The shared store's reorder on PostgreSQL as the application role (super list B0-1b): positions
// are rewritten for the owner's own filters of one list only, never another list's, owner's or
// Market's, and the role may update the `position` column but no other identity column.

const T0 = Temporal.Instant.from('2026-11-15T00:00:00Z');
const DENIED = '42501';
const LIST_A = 'admin.catalog.products';
const LIST_B = 'admin.ordering.orders';
let counter = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + counter++, crypto.getRandomValues(new Uint8Array(10)));
const idOf = <T extends string>(): Id<T> => {
  const parsed = parseId<T>(uuid7());
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value;
};

describe.each(TEST_MARKETS)('lists saved-filter reorder in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let db: Persistence;
  let owner: Client;
  let app: Client;
  let store: PrismaSavedFilterStore;

  beforeAll(async () => {
    db = createPersistence();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    app = new Client({ connectionString: testDatabaseUrl() });
    await Promise.all([owner.connect(), app.connect()]);
    store = new PrismaSavedFilterStore(db.service);
  });
  afterAll(async () => {
    await Promise.all([owner.end(), app.end()]);
    await db.close();
  });

  const filter = (
    listKey: string,
    ownerAccountId: Id<'Account'>,
    position: number,
  ): StoredFilter => ({
    id: idOf<'SavedFilter'>(),
    listKey,
    ownerAccountId,
    sellerId: null,
    visibility: 'me',
    name: `Filter ${uuid7().slice(-10)}`,
    payload: { v: 1 },
    position,
    createdAt: T0,
    updatedAt: T0,
  });
  const within = <T>(target: MarketContext, work: () => Promise<T>) =>
    db.unitOfWork.run(target, async () => ok(await work()), { isolation: 'serializable' });
  const positions = async (ownerAccountId: string, listKey: string) =>
    (
      await owner.query<{ id: string; position: number }>(
        `SELECT id, position FROM lists.saved_filters
          WHERE owner_account_id = $1 AND list_key = $2 ORDER BY position`,
        [ownerAccountId, listKey],
      )
    ).rows;

  it('rewrites the positions of the owner own filters of one list, and no other row', async () => {
    const mine = idOf<'Account'>();
    const theirs = idOf<'Account'>();
    const a = [filter(LIST_A, mine, 1), filter(LIST_A, mine, 2), filter(LIST_A, mine, 3)];
    const otherList = filter(LIST_B, mine, 1);
    const otherOwner = filter(LIST_A, theirs, 1);
    await within(market, async () => {
      for (const row of [...a, otherList, otherOwner]) await store.add(market, row);
    });

    const order = [a[2]!.id, a[0]!.id, a[1]!.id];
    const done = await within(market, () => store.reposition(market, null, LIST_A, mine, order));

    expect(done.ok && done.value).toBe(true);
    expect((await positions(mine, LIST_A)).map((row) => row.id)).toEqual(order);
    expect((await positions(mine, LIST_A)).map((row) => row.position)).toEqual([1, 2, 3]);
    expect((await positions(mine, LIST_B)).map((row) => row.position)).toEqual([1]);
    expect((await positions(theirs, LIST_A)).map((row) => row.position)).toEqual([1]);
  });

  it('reports a row that is gone and leaves another Market untouched', async () => {
    const mine = idOf<'Account'>();
    const rows = [filter(LIST_A, mine, 1), filter(LIST_A, mine, 2)];
    await within(market, async () => {
      for (const row of rows) await store.add(market, row);
    });
    const missing = idOf<'SavedFilter'>();

    // As the use case does: a refused reorder is an error from the unit, so the unit rolls back.
    const gone = await db.unitOfWork.run(
      market,
      async () => {
        const moved = await store.reposition(market, null, LIST_A, mine, [rows[1]!.id, missing]);
        return moved ? ok(true) : err('gone');
      },
      { isolation: 'serializable' },
    );
    const crossMarket = await within(other, () =>
      store.reposition(other, null, LIST_A, mine, [rows[1]!.id, rows[0]!.id]),
    );

    expect(gone.ok).toBe(false);
    expect(crossMarket.ok && crossMarket.value).toBe(false);
    expect(await positions(mine, LIST_A)).toEqual(
      rows.map((row, index) => ({ id: row.id, position: index + 1 })),
    );
  });

  it('keeps the filters of the admin Sales lists (no migration: the list_key CHECK is a pattern)', async () => {
    const mine = idOf<'Account'>();
    const keys = ['admin.ordering.shipments', 'admin.ordering.refunds', 'admin.ordering.documents'];
    for (const listKey of keys) {
      const row = filter(listKey, mine, 1);
      const added = await within(market, () => store.add(market, row));
      expect(added.ok && added.value).toBe('ok');
      expect(await positions(mine, listKey)).toEqual([{ id: row.id, position: 1 }]);
      const seen = await within(market, () => store.visibleTo(market, null, listKey, mine));
      expect(seen.ok && seen.value.map((found) => found.id)).toEqual([row.id]);
    }
  });

  it('lets the application role update the position column and nothing that identifies a row', async () => {
    const mine = idOf<'Account'>();
    const row = filter(LIST_A, mine, 1);
    await within(market, () => store.add(market, row));

    await app.query(`BEGIN`);
    await app.query(`SELECT set_config('app.market_id', $1, true)`, [market.marketId]);
    const position = await app
      .query(`UPDATE lists.saved_filters SET position = 7 WHERE id = $1`, [row.id])
      .then(() => 'ok')
      .catch((error: { code?: string }) => error.code);
    await app.query(`ROLLBACK`);
    const listKey = await app
      .query(`UPDATE lists.saved_filters SET list_key = 'x' WHERE id = $1`, [row.id])
      .then(() => 'ok')
      .catch((error: { code?: string }) => error.code);

    expect(position).not.toBe(DENIED);
    expect(listKey).toBe(DENIED);
  });
});
