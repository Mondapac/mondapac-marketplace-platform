import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { PrismaMissingDetailsEmailStore } from '../../src/modules/catalog/infrastructure/prisma-missing-details-email.store';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// The "Email sellers" requests of the Missing details report on PostgreSQL (attributes package
// A4-4), for both Market fixtures, as the API role: the guarded claim that makes the 7-day limit
// per seller and product (one winner when two admins ask at once), a settled request claimed
// again only when it is older than the limit or did not reach the seller, the queue the job reads,
// the CHECKs, and the grants (no delete, no change of the keys).

const T0 = Temporal.Instant.from('2026-11-11T04:00:00Z');
const DAY = 86_400_000;
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));

describe.each(TEST_MARKETS)('missing details email requests in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const admin = uuid7() as Id<'Account'>;
  let db: Persistence;
  let owner: Client;
  let store: PrismaMissingDetailsEmailStore;

  beforeAll(async () => {
    db = createPersistence();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
    store = new PrismaMissingDetailsEmailStore(db.service);
  });
  afterAll(async () => {
    await owner.end();
    await db.close();
  });

  const unit = async <T>(target: typeof market, work: () => Promise<T>) => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()));
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };
  const draft = (sellerId: string, productId: string, name = 'Dates') => ({
    sellerId: sellerId as Id<'Seller'>,
    productId,
    sellerName: 'Fresh Co',
    productName: name,
    missingLabels: ['Country of origin', 'Storage'],
  });
  const claim = (
    target: typeof market,
    d: ReturnType<typeof draft>,
    now: Temporal.Instant,
    by = admin,
  ) =>
    unit(target, () =>
      store.claim(target, d, {
        requestedBy: by,
        now,
        notAfter: now.subtract({ milliseconds: 7 * DAY }),
      }),
    );

  it('claims a new pair once and refuses it again within 7 days', async () => {
    const d = draft(uuid7(), uuid7());
    expect(await claim(market, d, T0)).toBe(true);
    expect(await claim(market, d, T0.add({ milliseconds: DAY }))).toBe(false);
    expect(await claim(market, d, T0.add({ milliseconds: 6 * DAY }))).toBe(false);
    const rows = await unit(market, () => store.latest(market, [d]));
    expect(rows).toEqual([
      { sellerId: d.sellerId, productId: d.productId, state: 'pending', requestedAt: T0 },
    ]);
  });

  it('claims again after 7 days, replacing the earlier request', async () => {
    const d = draft(uuid7(), uuid7());
    await claim(market, d, T0);
    await unit(market, () =>
      store.settle(market, d, { state: 'sent', attempts: 1 }, T0.add({ milliseconds: 1000 })),
    );
    const later = T0.add({ milliseconds: 7 * DAY + 1 });
    expect(await claim(market, { ...d, productName: 'Rice' }, later)).toBe(true);
    const pending = await unit(market, () => store.pending(market, 500));
    expect(pending.find((row) => row.productId === d.productId)).toMatchObject({
      productName: 'Rice',
      attempts: 0,
      requestedAt: later,
    });
  });

  it('never replaces a request that is still waiting in the queue, however old', async () => {
    const d = draft(uuid7(), uuid7());
    await claim(market, d, T0);
    const much = T0.add({ milliseconds: 30 * DAY });
    expect(await claim(market, { ...d, productName: 'Rice' }, much)).toBe(false);
    const pending = await unit(market, () => store.pending(market, 500));
    expect(pending.find((row) => row.productId === d.productId)).toMatchObject({
      productName: 'Dates',
      requestedAt: T0,
    });
  });

  it('claims again at once when the seller was not reached', async () => {
    const skipped = draft(uuid7(), uuid7());
    const failed = draft(uuid7(), uuid7());
    for (const [d, end] of [
      [skipped, { state: 'skipped', outcome: 'no-address', attempts: 0 }],
      [failed, { state: 'failed', outcome: 'send-failed', attempts: 3 }],
    ] as const) {
      await claim(market, d, T0);
      await unit(market, () => store.settle(market, d, end, T0));
      expect(await claim(market, d, T0.add({ milliseconds: 1000 }))).toBe(true);
    }
  });

  it('has one winner when two admins ask at the same time', async () => {
    const d = draft(uuid7(), uuid7());
    const results = await Promise.all([
      claim(market, d, T0, uuid7() as Id<'Account'>),
      claim(market, d, T0, uuid7() as Id<'Account'>),
      claim(market, d, T0, uuid7() as Id<'Account'>),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('keeps the Markets apart', async () => {
    const d = draft(uuid7(), uuid7());
    expect(await claim(market, d, T0)).toBe(true);
    expect(await claim(other, d, T0)).toBe(true);
    expect(await unit(other, () => store.latest(other, [d]))).toHaveLength(1);
    const mine = await unit(market, () => store.pending(market, 500));
    expect(mine.filter((row) => row.productId === d.productId)).toHaveLength(1);
  });

  it('lists pending requests oldest first and settles each once', async () => {
    const seller = uuid7();
    const a = draft(seller, uuid7(), 'A');
    const b = draft(seller, uuid7(), 'B');
    await claim(market, b, T0.add({ milliseconds: 2000 }));
    await claim(market, a, T0.add({ milliseconds: 1000 }));
    const pending = await unit(market, () => store.pending(market, 500));
    const mine = pending.filter((row) => row.sellerId === seller);
    expect(mine.map((row) => row.productName)).toEqual(['A', 'B']);
    expect(mine[0]?.missingLabels).toEqual(['Country of origin', 'Storage']);

    expect(
      await unit(market, () => store.settle(market, a, { state: 'pending', attempts: 1 }, T0)),
    ).toBe(true);
    expect(
      await unit(market, () => store.settle(market, a, { state: 'sent', attempts: 2 }, T0)),
    ).toBe(true);
    // Settled: a second settle changes nothing and the request leaves the queue.
    expect(
      await unit(market, () => store.settle(market, a, { state: 'sent', attempts: 3 }, T0)),
    ).toBe(false);
    const after = await unit(market, () => store.pending(market, 500));
    expect(after.some((row) => row.productId === a.productId)).toBe(false);
  });

  it('refuses rows that break the CHECKs', async () => {
    const insert = (over: Record<string, unknown>) => {
      const row: Record<string, unknown> = {
        market_id: market.marketId,
        tenant_id: market.tenantId,
        seller_id: uuid7(),
        product_id: uuid7(),
        seller_name: null,
        product_name: 'Dates',
        missing_labels: JSON.stringify(['Storage']),
        state: 'pending',
        outcome: null,
        attempts: 0,
        requested_at: T0.toString(),
        requested_by: uuid7(),
        settled_at: null,
        ...over,
      };
      const columns = Object.keys(row);
      return owner.query(
        `INSERT INTO catalog.missing_details_emails (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(row),
      );
    };
    await expect(insert({})).resolves.toBeDefined();
    await expect(insert({ state: 'queued' })).rejects.toThrow(/check constraint/);
    await expect(insert({ missing_labels: JSON.stringify([]) })).rejects.toThrow(/missing_labels/);
    await expect(insert({ missing_labels: JSON.stringify({ a: 1 }) })).rejects.toThrow(
      /missing_labels/,
    );
    await expect(
      insert({ state: 'sent', outcome: 'send-failed', settled_at: T0.toString() }),
    ).rejects.toThrow(/outcome_check/);
    await expect(
      insert({ state: 'failed', outcome: null, settled_at: T0.toString() }),
    ).rejects.toThrow(/outcome_check/);
    await expect(insert({ market_id: 'a' })).rejects.toThrow(/market_id_check/);
    await expect(
      insert({ state: 'skipped', outcome: 'send-failed', settled_at: T0.toString() }),
    ).rejects.toThrow(/outcome_check/);
    await expect(insert({ state: 'sent', settled_at: null })).rejects.toThrow(/settled_check/);
    await expect(insert({ product_name: '' })).rejects.toThrow(/product_name_check/);
    await expect(insert({ attempts: 11 })).rejects.toThrow(/attempts_check/);
  });

  it('lets the API role insert and update the content, never delete or move a key', async () => {
    const d = draft(uuid7(), uuid7());
    await claim(market, d, T0);
    const api = new Client({ connectionString: testDatabaseUrl() });
    await api.connect();
    try {
      await expect(
        api.query('DELETE FROM catalog.missing_details_emails WHERE seller_id = $1', [d.sellerId]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        api.query('UPDATE catalog.missing_details_emails SET seller_id = $2 WHERE seller_id = $1', [
          d.sellerId,
          uuid7(),
        ]),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await api.end();
    }
  });
});
