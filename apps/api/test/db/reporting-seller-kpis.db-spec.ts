import { ok, parseId, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { FactRecorder } from '../../src/modules/reporting/application/fact-recorder';
import { UNKNOWN_CATEGORY, type SellerOrderFact } from '../../src/modules/reporting/domain/facts';
import type { MarketDay } from '../../src/modules/reporting/domain/facts';
import { PrismaFactStore } from '../../src/modules/reporting/infrastructure/prisma-fact-store';
import { PrismaRollupStore } from '../../src/modules/reporting/infrastructure/prisma-rollup-store';
import { PrismaSellerKpiReader } from '../../src/modules/reporting/infrastructure/prisma-seller-kpi-reader';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';

// The seller KPI reader on PostgreSQL as the application role (dashboards upgrade phase 6, PR 16):
// it returns the rows of the seller asked for and nobody else's (a canary seller and a canary
// Market hold rows on the same days), in the range asked for.

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
const day = (text: string) => text as MarketDay;

describe.each(TEST_MARKETS)('the seller KPI reader in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const currency = CURRENCIES[code] as string;
  let db: Persistence;
  let recorder: FactRecorder;

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
  });
  afterAll(async () => {
    await db.close();
  });

  const within = <T>(target: MarketContext, work: () => Promise<T>) =>
    db.unitOfWork.run(target, async () => ok(await work()), { isolation: 'serializable' });

  const pay = (sellerId: Id<'Seller'>, target: MarketContext, paidAt: string, amount: bigint) => {
    const order: SellerOrderFact = {
      sellerOrderId: idOf<'SellerOrder'>(),
      orderId: idOf<'Order'>(),
      sellerId,
      currency: CURRENCIES[target.marketId] as string,
      goods: { amount, tax: amount / 11n },
      units: 1,
      shipping: { amount: 0n, tax: 0n },
      paidAt: Temporal.Instant.from(paidAt),
      cancelledAt: null,
      shippedAt: null,
      shippedOnTime: null,
      deliveredAt: null,
    };
    return within(target, () =>
      recorder.recordSellerOrder(target, order, [
        { categoryId: UNKNOWN_CATEGORY, goods: order.goods, units: 1 },
      ]),
    );
  };

  it("reads the asked seller's rows in the range, never another seller's or Market's", async () => {
    const mine = idOf<'Seller'>();
    const canary = idOf<'Seller'>();
    await pay(mine, market, '2026-11-20T03:00:00Z', 1100n);
    await pay(mine, market, '2026-11-12T03:00:00Z', 5500n); // outside both ranges
    await pay(canary, market, '2026-11-20T03:00:00Z', 9900n);
    await pay(mine, other, '2026-11-20T03:00:00Z', 7700n); // same seller id, other Market

    const reader = new PrismaSellerKpiReader(db.service);
    const read = await db.unitOfWork.run(
      market,
      async () =>
        ok(
          await reader.read(
            market,
            mine,
            currency,
            { from: day('2026-11-16'), to: day('2026-11-22') },
            { from: day('2026-11-09'), to: day('2026-11-15') },
          ),
        ),
      { readOnly: true },
    );
    if (!read.ok) throw new Error('read failed');
    expect(read.value.daily.map((row) => [row.marketDay, row.goodsAmount])).toEqual([
      ['2026-11-12', 5500n],
      ['2026-11-20', 1100n],
    ]);
    expect(read.value.categories.map((row) => row.salesAmount)).toEqual([1100n]);
  });
});
