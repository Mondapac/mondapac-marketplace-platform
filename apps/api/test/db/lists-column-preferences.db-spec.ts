import { parseId, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { ok } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import type { StoredColumnPreference } from '../../src/modules/lists/contracts';
import { PrismaColumnPreferenceStore } from '../../src/modules/lists/infrastructure/prisma-column-preference-store';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// The column choice on PostgreSQL as the application role (super list B0-2): one row per account
// and list, replaced by a second save; another account, list and Market never see or change it;
// the CHECKs bound the document; and the role can change the columns and update time only.

const T0 = Temporal.Instant.from('2026-11-15T00:00:00Z');
const T1 = Temporal.Instant.from('2026-11-15T01:00:00Z');
const DENIED = '42501';
const CHECK = '23514';
const LIST = 'admin.catalog.products';
let counter = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + counter++, crypto.getRandomValues(new Uint8Array(10)));
const idOf = <T extends string>(): Id<T> => {
  const parsed = parseId<T>(uuid7());
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value;
};

describe.each(TEST_MARKETS)('lists column preferences in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let db: Persistence;
  let owner: Client;
  let app: Client;
  let store: PrismaColumnPreferenceStore;

  beforeAll(async () => {
    db = createPersistence();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    app = new Client({ connectionString: testDatabaseUrl() });
    await Promise.all([owner.connect(), app.connect()]);
    store = new PrismaColumnPreferenceStore(db.service);
  });
  afterAll(async () => {
    await Promise.all([owner.end(), app.end()]);
    await db.close();
  });

  const within = <T>(target: MarketContext, work: () => Promise<T>) =>
    db.unitOfWork.run(target, async () => ok(await work()), { isolation: 'serializable' });
  const preference = (
    ownerAccountId: Id<'Account'>,
    columns: readonly string[],
    listKey = LIST,
    at = T0,
  ): StoredColumnPreference => ({
    id: idOf<'ColumnPreference'>(),
    listKey,
    ownerAccountId,
    sellerId: null,
    columns,
    createdAt: at,
    updatedAt: at,
  });
  const rows = async (accountId: string) =>
    (
      await owner.query<{ list_key: string; columns: string[]; created_at: Date }>(
        `SELECT list_key, columns, created_at FROM lists.column_preferences
          WHERE owner_account_id = $1 ORDER BY list_key`,
        [accountId],
      )
    ).rows;

  it('saves, replaces on a second save, finds and removes, one row per account and list', async () => {
    const mine = idOf<'Account'>();
    await within(market, () => store.put(market, preference(mine, ['code', 'offers'])));
    await within(market, () => store.put(market, preference(mine, ['updated'], LIST, T1)));
    await within(market, () =>
      store.put(market, preference(mine, ['code'], 'admin.ordering.orders')),
    );

    const found = await within(market, () => store.find(market, null, LIST, mine));
    const stored = await rows(mine);

    expect(found.ok && found.value?.columns).toEqual(['updated']);
    expect(stored.map((row) => [row.list_key, row.columns])).toEqual([
      [LIST, ['updated']],
      ['admin.ordering.orders', ['code']],
    ]);
    // The first save's creation time stays; only the columns and update time changed.
    expect(stored[0]!.created_at.toISOString()).toBe(T0.toString().replace('Z', '.000Z'));

    await within(market, () => store.remove(market, null, LIST, mine));
    await within(market, () => store.remove(market, null, LIST, mine));
    expect((await rows(mine)).map((row) => row.list_key)).toEqual(['admin.ordering.orders']);
  });

  it('never finds, changes or removes the choice of another account or Market', async () => {
    const mine = idOf<'Account'>();
    const theirs = idOf<'Account'>();
    await within(market, () => store.put(market, preference(mine, ['code'])));

    const another = await within(market, () => store.find(market, null, LIST, theirs));
    const crossMarket = await within(other, () => store.find(other, null, LIST, mine));
    await within(other, () => store.remove(other, null, LIST, mine));
    await within(other, () => store.put(other, preference(mine, ['offers'])));

    expect(another.ok && another.value).toBeNull();
    expect(crossMarket.ok && crossMarket.value).toBeNull();
    const kept = await within(market, () => store.find(market, null, LIST, mine));
    expect(kept.ok && kept.value?.columns).toEqual(['code']);
    const both = (
      await owner.query(
        `SELECT market_id FROM lists.column_preferences WHERE owner_account_id = $1 ORDER BY market_id`,
        [mine],
      )
    ).rows.map((row: { market_id: string }) => row.market_id);
    expect(both).toEqual([market.marketId, other.marketId].sort());
  });

  it('bounds the document with CHECKs and lets the application role change only columns and time', async () => {
    const mine = idOf<'Account'>();
    const saved = preference(mine, ['code']);
    await within(market, () => store.put(market, saved));

    const insert = (columns: string, listKey = LIST) =>
      owner
        .query(
          `INSERT INTO lists.column_preferences
             (id, market_id, tenant_id, owner_account_id, list_key, columns, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, now(), now())`,
          [uuid7(), market.marketId, market.tenantId, idOf<'Account'>(), listKey, columns],
        )
        .then(() => 'ok')
        .catch((error: { code?: string }) => error.code);
    expect(await insert('{"a":1}')).toBe(CHECK);
    expect(await insert(JSON.stringify(['x'.repeat(1100)]))).toBe(CHECK);
    expect(await insert('[]', 'Bad Key')).toBe(CHECK);

    const attempt = (column: string, value: string) =>
      app
        .query(`UPDATE lists.column_preferences SET ${column} = ${value} WHERE id = $1`, [saved.id])
        .then(() => 'ok')
        .catch((error: { code?: string }) => error.code);
    expect(await attempt('columns', `'["offers"]'::jsonb`)).toBe('ok');
    expect(await attempt('updated_at', 'now()')).toBe('ok');
    expect(await attempt('owner_account_id', `'${idOf<'Account'>()}'`)).toBe(DENIED);
    expect(await attempt('list_key', `'admin.catalog.other'`)).toBe(DENIED);
    expect(await attempt('market_id', `'ZZ'`)).toBe(DENIED);
    expect(await attempt('created_at', 'now()')).toBe(DENIED);
  });
});
