import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import { FakeCommission } from '../../../../test/support/ordering-fakes';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import type { Refund } from '../domain/refund';
import type { OrderingDependencies } from './checkout-flow';
import { recordRefundLedger } from './ledger-flow';
import type { RefundForLedger, RefundRepository } from './ports/refund.repository';

// The refund ledger step in memory, on both Market fixtures: a refunded line whose order line
// amount is 0 wrote no ledger rows, so the step leaves it out of the facts (the paid flow skips a
// zero line amount); a refund with nothing left is still marked handled.

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const PAID = id<'OrderLine'>(0x31);
const FREE = id<'OrderLine'>(0x32);
const T0 = Temporal.Instant.from('2026-10-25T10:00:00Z');

describe.each([['AU'], ['ZZ']] as const)('the refund ledger step in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const context: CallContext = testCallContext(market, 'system');
  const line = (orderLineId: Id<'OrderLine'>) => ({
    orderLineId,
    quantity: 1,
    lineQuantity: 2,
    unitsBefore: 0,
    gross: 100n,
    tax: 0n,
    taxRateBps: 0,
    taxInclusive: true,
  });
  const item = (lines: Id<'OrderLine'>[], over: Partial<Refund> = {}): RefundForLedger => ({
    refund: {
      id: id<'Refund'>(0x41),
      orderId: id<'Order'>(1),
      sellerOrderId: id<'SellerOrder'>(2),
      sellerId: id<'Seller'>(3),
      currency: code === 'AU' ? 'AUD' : 'JPY',
      lossBearer: 'seller',
      lossReasonCode: null,
      settledAt: T0,
      shipping: null,
      lines: lines.map(line),
      ...over,
    } as Refund,
    sellerOrderLedgerState: 'recorded',
    shippingCharge: null,
    freeLines: new Set([FREE]),
  });

  const run = async (found: RefundForLedger) => {
    const marked: string[] = [];
    const counted: string[] = [];
    const refunds = {
      findUnrecordedLedger: () => Promise.resolve([found]),
      markLedgerRecorded: (_m: unknown, refundId: string) => {
        marked.push(refundId);
        return Promise.resolve();
      },
      countLedgerFailure: (_m: unknown, refundId: string) => {
        counted.push(refundId);
        return Promise.resolve(1);
      },
    } as unknown as RefundRepository;
    const commission = new FakeCommission();
    const deps = {
      unitOfWork: new FakeUnitOfWork(),
      refunds,
      commission,
      clock: new FixedClock(T0),
    } as unknown as OrderingDependencies;
    const result = await recordRefundLedger(deps, context);
    return { result, commission, marked, counted };
  };

  it('leaves the free line out of a mixed refund and records the paid one', async () => {
    const { result, commission, marked } = await run(item([PAID, FREE]));
    expect(result).toMatchObject({ ok: true, value: { recorded: 1, failed: [] } });
    expect(commission.refundsRecorded).toHaveLength(1);
    expect(commission.refundsRecorded[0]!.lines.map((l) => l.orderLineId)).toEqual([PAID]);
    expect(marked).toEqual([id<'Refund'>(0x41)]);
  });

  it('marks a refund of only free lines handled without calling the ledger', async () => {
    const { result, commission, marked, counted } = await run(item([FREE]));
    expect(result).toMatchObject({ ok: true, value: { recorded: 1, failed: [] } });
    expect(commission.refundsRecorded).toEqual([]);
    expect(marked).toEqual([id<'Refund'>(0x41)]);
    expect(counted).toEqual([]);
  });

  it('still sends a free-line refund that has a shipping part, without the line', async () => {
    const withShipping = item([FREE], {
      shipping: { gross: 50n, tax: 0n, taxRateBps: 0, taxInclusive: true, before: 0n },
    });
    const { commission } = await run({ ...withShipping, shippingCharge: 100n });
    expect(commission.refundsRecorded[0]).toMatchObject({
      lines: [],
      shipping: { refundedBefore: 0n, refundedAfter: 50n, charge: 100n },
    });
  });
});
