import { ok, parseId, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { FactRecorder } from '../../src/modules/reporting/application/fact-recorder';
import { UNKNOWN_CATEGORY, type SellerOrderFact } from '../../src/modules/reporting/domain/facts';
import type { MarketDay } from '../../src/modules/reporting/domain/facts';
import { PrismaAdminKpiReader } from '../../src/modules/reporting/infrastructure/prisma-admin-kpi-reader';
import { PrismaFactStore } from '../../src/modules/reporting/infrastructure/prisma-fact-store';
import { PrismaRollupStore } from '../../src/modules/reporting/infrastructure/prisma-rollup-store';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';

// The admin KPI read on PostgreSQL as the application role (dashboards upgrade phase 5): the
// daily rollups of every seller are summed per Market day, only inside the range, only in the
// Market's currency and only for the caller's Market.

const ZONES: Record<string, string> = { AU: 'Australia/Brisbane', ZZ: 'Asia/Tokyo' };
const CURRENCIES: Record<string, string> = { AU: 'AUD', ZZ: 'JPY' };
let counter = 0;
const idOf = <T extends string>(): Id<T> => {
  const parsed = parseId<T>(
    uuidV7(Date.now() + counter++, crypto.getRandomValues(new Uint8Array(10))),
  );
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value;
};
const at = (text: string) => Temporal.Instant.from(text);
const day = (text: string) => text as MarketDay;

describe.each(TEST_MARKETS)('the admin KPI reader in market %s (database)', (code) => {
  // One month per Market fixture: the rows of the other Market's run stay outside this range.
  const M = code === TEST_MARKETS[0] ? '03' : '04';
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const currency = CURRENCIES[code] as string;
  let db: Persistence;
  let recorder: FactRecorder;
  let reader: PrismaAdminKpiReader;

  beforeAll(() => {
    db = createPersistence();
    const now = () => Temporal.Now.instant();
    recorder = new FactRecorder({
      facts: new PrismaFactStore(db.service, now),
      rollups: new PrismaRollupStore(db.service, now),
      zone: {
        zoneOf: (target: MarketContext) => ZONES[target.marketId] as string,
        currencyOf: (target: MarketContext) => CURRENCIES[target.marketId] as string,
      },
    });
    reader = new PrismaAdminKpiReader(db.service);
  });
  afterAll(() => db.close());

  const within = <T>(target: MarketContext, work: () => Promise<T>) =>
    db.unitOfWork.run(target, async () => ok(await work()), { isolation: 'serializable' });

  const order = (
    sellerId: Id<'Seller'>,
    paidAt: string,
    goods: bigint,
    overrides: Partial<SellerOrderFact> = {},
    orderCurrency: string = currency,
  ): SellerOrderFact => ({
    sellerOrderId: idOf<'SellerOrder'>(),
    orderId: idOf<'Order'>(),
    sellerId,
    currency: orderCurrency,
    goods: { amount: goods, tax: goods / 11n },
    units: 1,
    shipping: { amount: 0n, tax: 0n },
    paidAt: at(paidAt),
    cancelledAt: null,
    shippedAt: null,
    shippedOnTime: null,
    deliveredAt: null,
    ...overrides,
  });

  const record = (target: MarketContext, fact: SellerOrderFact) =>
    within(target, () =>
      recorder.recordSellerOrder(target, fact, [
        { categoryId: UNKNOWN_CATEGORY, goods: fact.goods, units: fact.units },
      ]),
    );

  it('sums every seller per day inside the range, in the currency and Market asked for', async () => {
    // Mid-day UTC: the same calendar day in Brisbane and Tokyo. A month of their own keeps these rows away
    // from the other specs' November days.
    const a = idOf<'Seller'>();
    const b = idOf<'Seller'>();
    await record(market, order(a, `2026-${M}-10T03:00:00Z`, 11_000n));
    await record(
      market,
      order(b, `2026-${M}-10T04:00:00Z`, 22_000n, {
        shippedAt: at(`2026-${M}-11T03:00:00Z`),
        shippedOnTime: true,
      }),
    );
    await record(market, order(a, `2026-${M}-12T03:00:00Z`, 5_500n));
    await record(market, order(a, `2026-${M}-20T03:00:00Z`, 99_000n)); // outside the range
    await record(
      other,
      order(a, `2026-${M}-10T03:00:00Z`, 1_000_000n, {}, CURRENCIES[otherMarketOf(code)]),
    );

    const range = { from: day(`2026-${M}-10`), to: day(`2026-${M}-14`) };
    const readIn = async (target: MarketContext, rowCurrency: string, readRange: typeof range) => {
      const unit = await db.unitOfWork.run(
        target,
        async () => ok(await reader.dailyTotals(target, rowCurrency, readRange)),
        { readOnly: true },
      );
      if (!unit.ok) throw new Error('read failed');
      return unit.value;
    };
    const out = await readIn(market, currency, range);
    expect(out.days.map((row) => [row.day, row.ordersPaid, row.goodsAmount, row.goodsTax])).toEqual(
      [
        [`2026-${M}-10`, 2, 33_000n, 3_000n],
        [`2026-${M}-11`, 0, 0n, 0n],
        [`2026-${M}-12`, 1, 5_500n, 500n],
      ],
    );
    const shipped = out.days.find((row) => row.day === `2026-${M}-11`);
    expect(shipped).toMatchObject({ ordersShipped: 1, ordersShippedOnTime: 1 });
    expect(out.refreshedAt).not.toBeNull();

    // Another currency, or nothing in the range, reads as nothing, never as zeros of a day.
    expect((await readIn(market, 'XXX', range)).days).toEqual([]);
    const none = await readIn(market, currency, {
      from: day('2026-02-01'),
      to: day('2026-02-02'),
    });
    expect(none).toEqual({ days: [], refreshedAt: null });
  });
});
