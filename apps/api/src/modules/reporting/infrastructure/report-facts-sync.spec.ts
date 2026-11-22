import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import { fakeRunOnce } from '../../../../test/support/fake-run-once';
import { TEST_MARKETS } from '../../../../test/support/test-config';
import type { EventDelivery } from '../../../platform/events/event-delivery';
import type { UnitOfWork, UnitOfWorkOptions } from '../../../platform/unit-of-work/unit-of-work';
import type { RefundReportFacts, SellerOrderReportFacts } from '../../ordering';
import { UNKNOWN_CATEGORY } from '../domain/facts';
import { refundSource, sellerOrderSource } from './facade-report-sources';
import type { FactRecorder } from '../application/fact-recorder';
import type { ReportSources, SellerOrderSource } from '../application/ports/report-sources';
import { TransactionConflictError } from '../../../platform/unit-of-work/errors';
import {
  isFactRefusal,
  recordFromEvent,
  reconcileWindowAt,
  type ReportFactsDependencies,
} from '../application/report-facts-sync';

// The event worker of reporting without a database (dashboards upgrade phase 3, PR 10b): a
// delivery is recorded once in a serializable unit, a never-paid seller order is not recorded,
// a failed owner read writes nothing, the request is bounded, and the facade facts map to goods
// by category that always add up.

const T0 = Temporal.Instant.from('2026-11-20T02:00:00Z');
const id = <T extends string>(n: number) =>
  `0193a000-0000-7000-8000-${String(n).padStart(12, '0')}` as Id<T>;

describe.each(TEST_MARKETS)('reporting event worker in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const currency = code === 'AU' ? 'AUD' : 'JPY';
  const context = testCallContext(market, 'system');

  const fact = (n: number, paidAt: Temporal.Instant | null): SellerOrderReportFacts => ({
    orderId: id<'Order'>(n),
    sellerOrderId: id<'SellerOrder'>(n),
    sellerId: id<'Seller'>(1),
    currency,
    lines: [{ offerId: id<'Offer'>(n), quantity: 2, goods: { amount: 2200n, tax: 200n } }],
    shipping: { amount: 550n, tax: 50n },
    paidAt,
    cancelledAt: null,
    shippedAt: null,
    shippedOnTime: null,
    deliveredAt: null,
  });

  const setup = (sources: Partial<ReportSources>) => {
    const batches: { sellerOrders: readonly SellerOrderSource[] }[] = [];
    const options: (UnitOfWorkOptions | undefined)[] = [];
    const runOnce = fakeRunOnce();
    const unitOfWork: UnitOfWork = {
      run: () => Promise.reject(new Error('run is not expected')),
      runOnce: (target, delivery, work, opts) => {
        options.push(opts);
        return runOnce(target, delivery, work);
      },
    };
    const recorder = {
      recordBatch: (_m: unknown, batch: { sellerOrders: readonly SellerOrderSource[] }) => {
        batches.push(batch);
        return Promise.resolve();
      },
    } as unknown as FactRecorder;
    const deps: ReportFactsDependencies = {
      unitOfWork,
      recorder,
      clock: new FixedClock(T0),
      sources: sources as ReportSources,
    };
    return { deps, batches, options };
  };
  const delivery = (n: number): EventDelivery => ({
    eventId: id<'event'>(n),
    subscriber: 'reporting.order-paid',
    attempt: 1,
  });

  it('records a delivery once, in a serializable unit, without a never-paid seller order', async () => {
    const { deps, batches, options } = setup({
      sellerOrders: () =>
        Promise.resolve(
          ok([fact(1, T0), fact(2, null)].map((f) => sellerOrderSource(f, new Map()))),
        ),
    });
    const request = { sellerOrders: [{ orderId: id(1), sellerOrderId: null }], refundIds: [] };
    const first = await recordFromEvent(deps, context, delivery(1), request);
    expect(first).toEqual(ok({ handled: true, sellerOrders: 1, refunds: 0 }));
    const again = await recordFromEvent(deps, context, delivery(1), request);
    expect(again).toEqual(ok({ handled: false, sellerOrders: 0, refunds: 0 }));
    expect(batches).toHaveLength(1);
    expect(batches[0]!.sellerOrders.map((s) => s.order.sellerOrderId)).toEqual([id(1)]);
    expect(options.every((o) => o?.isolation === 'serializable')).toBe(true);
  });

  it('writes nothing when an owner read fails, and refuses an oversized request', async () => {
    const { deps, batches } = setup({
      sellerOrders: () =>
        Promise.resolve(err({ code: 'reporting.source-unavailable', cause: 'ordering' })),
    });
    const failed = await recordFromEvent(deps, context, delivery(2), {
      sellerOrders: [{ orderId: id(1), sellerOrderId: null }],
      refundIds: [],
    });
    expect(!failed.ok && failed.error.code).toBe('reporting.source-unavailable');
    const tooMany = await recordFromEvent(deps, context, delivery(3), {
      sellerOrders: [],
      refundIds: Array.from({ length: 101 }, (_, n) => id(n)),
    });
    expect(!tooMany.ok && tooMany.error.code).toBe('validation.failed');
    expect(batches).toHaveLength(0);
  });

  it('places goods in categories that add up: an unknown Offer and an uncovered refund part', () => {
    const known = id<'Offer'>(7);
    const category = id<'Category'>(9);
    const order: SellerOrderReportFacts = {
      ...fact(3, T0),
      lines: [
        { offerId: known, quantity: 1, goods: { amount: 1100n, tax: 100n } },
        { offerId: id<'Offer'>(8), quantity: 3, goods: { amount: 3300n, tax: 300n } },
      ],
    };
    const source = sellerOrderSource(order, new Map([[known, category]]));
    expect(source.order.goods).toEqual({ amount: 4400n, tax: 400n });
    expect(source.order.units).toBe(4);
    expect(source.goods.map((g) => g.categoryId)).toEqual([category, UNKNOWN_CATEGORY]);

    const refund: RefundReportFacts = {
      refundId: id<'Refund'>(1),
      orderId: order.orderId,
      sellerOrderId: order.sellerOrderId,
      sellerId: order.sellerId,
      currency,
      total: { amount: 2750n, tax: 250n },
      shipping: { amount: 550n, tax: 50n },
      refundedAt: T0,
      lines: [{ offerId: known, quantity: 1, goods: { amount: 1100n, tax: 100n } }],
    };
    const refunded = refundSource(refund, new Map([[known, category]]));
    expect(refunded.goods).toEqual([
      { categoryId: category, goods: { amount: 1100n, tax: 100n }, units: 1 },
      { categoryId: UNKNOWN_CATEGORY, goods: { amount: 1100n, tax: 100n }, units: 0 },
    ]);
  });

  it('reconciles the last seven days', () => {
    expect(reconcileWindowAt(T0)).toEqual({ from: T0.subtract({ hours: 168 }), to: T0 });
  });
});

describe('reporting write failures', () => {
  const prismaError = (code: string, sqlState?: string) =>
    Object.assign(new Error('masked'), {
      name: 'PrismaClientKnownRequestError',
      code,
      meta:
        sqlState === undefined ? {} : { driverAdapterError: { cause: { originalCode: sqlState } } },
    });

  it('counts a value the database refuses as a refusal, and a passing failure as not', () => {
    expect(isFactRefusal(prismaError('P2010', '23514'))).toBe(true); // a CHECK
    expect(isFactRefusal(prismaError('P2010', '22001'))).toBe(true); // too long
    expect(isFactRefusal(prismaError('P2003'))).toBe(true);
    expect(isFactRefusal(new RangeError('another currency'))).toBe(true);
    expect(isFactRefusal(prismaError('P2010', '57014'))).toBe(false); // statement timeout
    expect(isFactRefusal(prismaError('P1017'))).toBe(false); // connection closed
    expect(isFactRefusal(new TransactionConflictError('40001'))).toBe(false);
    expect(isFactRefusal(new Error('connection lost'))).toBe(false);
  });
});
