import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import {
  MarketGuardError,
  MarketMismatchError,
  NamedStatementRefusedError,
  NoUnitOfWorkError,
  TransactionConflictError,
} from '../../src/platform/unit-of-work/errors';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  gate,
  marketOf,
  otherMarketOf,
  timed,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// Platform persistence 4.2 and inventory data design 4.2 and 4.3: the named statement
// `inventory.lock-stock-items` and the `lockTimeoutMs` option, on PostgreSQL, for both Market
// fixtures, as the application role. Every row here has fresh ids, so the specs of the other
// files sharing the run database are not affected by the locks.

const T0 = Temporal.Instant.from('2026-10-08T10:00:00Z');
const at = (seconds: number): string => T0.add({ seconds }).toString();
const NAME = 'inventory.lock-stock-items';

describe.each(TEST_MARKETS)('inventory.lock-stock-items in market %s (database)', (code) => {
  const market = marketOf(code);
  const otherCode = otherMarketOf(code);
  const otherMarket = marketOf(otherCode);
  const ids = new UuidV7IdGenerator(new FixedClock(T0));
  let db: Persistence;
  let sql: Client;

  beforeAll(async () => {
    db = createPersistence();
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });
  afterAll(async () => {
    await db.close();
    await sql.end();
  });

  async function insert(table: string, row: Record<string, unknown>): Promise<void> {
    const columns = Object.keys(row);
    await sql.query(
      `INSERT INTO inventory.${table} (${columns.join(', ')})
       VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
      Object.values(row),
    );
  }

  /** `count` stock items of one seller in `marketCode`, each of its own sell unit. */
  async function newItems(count: number, marketCode = code, retiredFrom = Infinity) {
    const sellerId = ids.next<'Seller'>();
    await insert('seller_inventories', {
      id: ids.next(),
      market_id: marketCode,
      tenant_id: 'default',
      seller_id: sellerId,
      version: 1,
      created_at: at(0),
    });
    const sourceId = ids.next<'InventorySource'>();
    await insert('sources', {
      id: sourceId,
      market_id: marketCode,
      tenant_id: 'default',
      seller_id: sellerId,
      name: 'Default',
      is_default: true,
      priority: 1,
      created_at: at(0),
    });
    const items: { id: string; offer_id: string; variant_id: string; on_hand: number }[] = [];
    for (let index = 0; index < count; index += 1) {
      const row = {
        id: ids.next<string>() as string,
        market_id: marketCode,
        tenant_id: 'default',
        offer_id: ids.next<string>() as string,
        variant_id: ids.next<string>() as string,
        source_id: sourceId,
        seller_id: sellerId,
        on_hand: index + 1,
        retired_at: index >= retiredFrom ? at(1) : null,
        version: 1,
        created_at: at(0),
      };
      await insert('stock_items', row);
      items.push({
        id: row.id,
        offer_id: row.offer_id,
        variant_id: row.variant_id,
        on_hand: row.on_hand,
      });
    }
    return { sellerId, sourceId, items };
  }

  const lock = (context: MarketContext, wanted: readonly string[]) =>
    db.service.namedQuery(context, NAME, { ids: wanted });

  it('locks the items in ascending id order whatever the order asked, retired ones included', async () => {
    const { sellerId, sourceId, items } = await newItems(3, code, 2);
    const asked = [items[2]!.id, items[0]!.id, items[1]!.id, items[0]!.id];

    const result = await db.unitOfWork.run(market, async () => ok(await lock(market, asked)));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((row) => row.id)).toEqual([...items.map((item) => item.id)].sort());
    const byId = new Map(result.value.map((row) => [row.id, row]));
    expect(byId.get(items[0]!.id)).toEqual({
      id: items[0]!.id,
      offerId: items[0]!.offer_id,
      variantId: items[0]!.variant_id,
      sourceId,
      sellerId,
      onHand: 1,
      retiredAt: null,
      version: 1,
    });
    expect(byId.get(items[2]!.id)!.retiredAt).toEqual(new Date(at(1)));
  });

  it('fails as a whole when one id belongs to the other Market, and locks nothing', async () => {
    const mine = await newItems(1);
    const theirs = await newItems(1, otherCode);

    const run = db.unitOfWork.run(market, async () =>
      ok(await lock(market, [mine.items[0]!.id, theirs.items[0]!.id])),
    );

    await expect(run).rejects.toEqual(new NamedStatementRefusedError(NAME, 'rows-missing'));
    // The other Market's own unit still sees and locks its item.
    const own = await db.unitOfWork.run(otherMarket, async () =>
      ok(await lock(otherMarket, [theirs.items[0]!.id])),
    );
    expect(own.ok && own.value.map((row) => row.id)).toEqual([theirs.items[0]!.id]);
  });

  it('fails for an id that does not exist', async () => {
    const run = db.unitOfWork.run(market, async () => ok(await lock(market, [ids.next()])));

    await expect(run).rejects.toEqual(new NamedStatementRefusedError(NAME, 'rows-missing'));
  });

  it('commits nothing of a unit whose lock call failed', async () => {
    const { items } = await newItems(1);

    await expect(
      db.unitOfWork.run(market, async () => {
        await lock(market, [items[0]!.id]);
        await lock(market, [ids.next()]);
        return ok(null);
      }),
    ).rejects.toBeInstanceOf(NamedStatementRefusedError);

    const { rows } = await sql.query(
      'SELECT on_hand FROM inventory.stock_items WHERE market_id = $1 AND id = $2',
      [code, items[0]!.id],
    );
    expect(rows).toEqual([{ on_hand: 1 }]);
  });

  it('refuses the call outside a unit, for another Market, and in a read-only unit', async () => {
    const { items } = await newItems(1);

    await expect(lock(market, [items[0]!.id])).rejects.toEqual(new NoUnitOfWorkError());
    await expect(
      db.unitOfWork.run(market, async () => ok(await lock(otherMarket, [items[0]!.id]))),
    ).rejects.toEqual(new MarketMismatchError());
    await expect(
      db.unitOfWork.run(market, async () => ok(await lock(market, [items[0]!.id])), {
        readOnly: true,
      }),
    ).rejects.toEqual(new NamedStatementRefusedError(NAME, 'read-only-unit'));
  });

  it('lets a rolled-back unit (err) release its locks at once', async () => {
    const { items } = await newItems(2);

    const first = await db.unitOfWork.run(market, async () => {
      await lock(
        market,
        items.map((item) => item.id),
      );
      return err('declined' as const);
    });
    const second = await db.unitOfWork.run(
      market,
      async () =>
        ok(
          await lock(
            market,
            items.map((item) => item.id),
          ),
        ),
      { lockTimeoutMs: 200 },
    );

    expect(first).toEqual(err('declined'));
    expect(second.ok).toBe(true);
  });

  describe('the lock strength and lockTimeoutMs', () => {
    it('makes a second locker wait, and ends its unit with 55P03 after lockTimeoutMs', async () => {
      const { items } = await newItems(2);
      const wanted = items.map((item) => item.id);
      const holding = gate();
      const locked = gate();
      const holder = db.unitOfWork.run(market, async () => {
        await lock(market, wanted);
        locked.open();
        await holding.opened;
        return ok(null);
      });
      await locked.opened;

      const waiter = await timed(
        db.unitOfWork.run(market, async () => ok(await lock(market, [wanted[1]!])), {
          lockTimeoutMs: 300,
        }),
      );
      holding.open();
      await holder;

      expect(waiter.error).toEqual(new TransactionConflictError('55P03'));
      expect(waiter.ms).toBeGreaterThanOrEqual(250);
      expect(waiter.ms).toBeLessThan(2000);
    });

    it('applies the timeout to every attempt, and a later unit without it is not affected', async () => {
      const { items } = await newItems(1);
      const wanted = [items[0]!.id];
      const holding = gate();
      const locked = gate();
      const holder = db.unitOfWork.run(market, async () => {
        await lock(market, wanted);
        locked.open();
        await holding.opened;
        return ok(null);
      });
      await locked.opened;

      const short = await timed(
        db.unitOfWork.run(market, async () => ok(await lock(market, wanted)), {
          lockTimeoutMs: 150,
        }),
      );
      // The same pooled connection serves the next unit: `SET LOCAL` ended with the first.
      const release = setTimeout(() => holding.open(), 700);
      const patient = await timed(
        db.unitOfWork.run(market, async () => ok(await lock(market, wanted))),
      );
      clearTimeout(release);
      await holder;

      expect(short.error).toEqual(new TransactionConflictError('55P03'));
      expect(short.ms).toBeLessThan(600);
      expect(patient.error).toBeUndefined();
      expect(patient.ms).toBeGreaterThanOrEqual(500);
    });

    it('does not block the foreign-key checks of a ledger row on a locked item (FOR NO KEY UPDATE)', async () => {
      const { items } = await newItems(1);
      const item = items[0]!;
      const holding = gate();
      const locked = gate();
      const holder = db.unitOfWork.run(market, async () => {
        await lock(market, [item.id]);
        locked.open();
        await holding.opened;
        return ok(null);
      });
      await locked.opened;

      const insertion = await timed(
        insert('stock_movements', {
          id: ids.next(),
          market_id: code,
          tenant_id: 'default',
          stock_item_id: item.id,
          offer_id: item.offer_id,
          variant_id: item.variant_id,
          delta: 1,
          resulting_on_hand: 2,
          reason: 'seller-set',
          actor_kind: 'account',
          actor_account_id: ids.next(),
          correlation_id: 'corr-0000001',
          occurred_at: at(2),
        }),
      );
      holding.open();
      await holder;

      expect(insertion.error).toBeUndefined();
      expect(insertion.ms).toBeLessThan(1000);
    });
  });

  it('never deadlocks crossing sets of the same items asked in opposite orders', async () => {
    const { items } = await newItems(6);
    const all = items.map((item) => item.id);
    const subsetOf = (seed: number) =>
      [0, 1, 2].map((offset) => all[(seed * 5 + offset * 2) % all.length]!);

    const results = await Promise.allSettled(
      Array.from({ length: 24 }, (_, seed) =>
        db.unitOfWork.run(market, async () => {
          const wanted = seed % 2 === 0 ? subsetOf(seed) : subsetOf(seed).reverse();
          const rows = await lock(market, wanted);
          return ok(rows.length);
        }),
      ),
    );

    expect(results.filter((result) => result.status === 'rejected')).toEqual([]);
  });

  it('keeps raw SQL refused for anything the platform did not build', async () => {
    await expect(
      db.unitOfWork.run(market, async () => {
        await db.client.$queryRaw`SELECT 1`;
        return ok(null);
      }),
    ).rejects.toEqual(new MarketGuardError('raw-sql', null, '$queryRaw'));
    await expect(
      db.unitOfWork.run(market, async () => {
        await db.client.$executeRawUnsafe('SET LOCAL lock_timeout = 1');
        return ok(null);
      }),
    ).rejects.toEqual(new MarketGuardError('raw-sql', null, '$executeRawUnsafe'));
  });
});
