import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKETS } from '../../../../test/support/test-config';
import type { CommissionPayoutsFacade } from '../../commission-payouts';
import type { OrderingFacade } from '../../ordering';
import { FacadeDeliveredOrderFacts } from './facade-delivered-order-facts';
import { FacadePayoutAnchors } from './facade-payout-anchors';
import { FacadeSellerCashbackLedger } from './facade-seller-cashback-ledger';

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const T0 = Temporal.Instant.from('2026-11-17T10:00:00Z');

// The two adapters customers phase 4c wires: the delivered order's facts read from ordering, and
// the seller's cashback written to the seller ledger. Only the system actor reaches either; any
// failure, a thrown one included, is "unknown" or "not recorded", so the delivery is retried and
// nothing is credited or debited on a guess.
describe.each(TEST_MARKETS)('the seller cashback adapters in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const system: CallContext = testCallContext(market, 'system', 'cashback-adapter-abcd');
  const seller: CallContext = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'seller',
      accountId: id<'Account'>(9),
      sessionId: id<'Session'>(8),
      sellerId: id<'Seller'>(7),
    }),
    'cashback-adapter-efgh',
  );
  const currency = code === 'AU' ? 'AUD' : 'JPY';
  const facts = {
    orderId: id<'Order'>(1),
    sellerOrderId: id<'SellerOrder'>(2),
    sellerId: id<'Seller'>(3),
    customerAccountId: id<'Account'>(4),
    currency,
    goods: 1234n,
    refundedGoods: 234n,
    // 200 of the 234 by refunds that succeeded (a pending one may still fail).
    succeededRefundedGoods: 200n,
    exclusiveSeller: true,
    placedAt: T0,
    deliveredAt: T0.add({ hours: 30 }),
  };
  const ordering = (answer: () => Promise<unknown>) =>
    ({ deliveredSellerOrderFacts: answer }) as unknown as OrderingFacade;
  const request = { orderId: facts.orderId, sellerOrderId: facts.sellerOrderId };

  it('reads the facts as the goods kept (less refunds), never a test order', async () => {
    const adapter = new FacadeDeliveredOrderFacts(ordering(() => Promise.resolve(ok(facts))));
    expect(await adapter.read(system, request)).toEqual({
      known: true,
      value: {
        orderId: facts.orderId,
        sellerOrderId: facts.sellerOrderId,
        sellerId: facts.sellerId,
        customerAccountId: facts.customerAccountId,
        goodsPaid: { amount: 1000n, currency },
        goodsKeptSettled: { amount: 1034n, currency },
        exclusiveSeller: true,
        placedAt: T0,
        deliveredAt: T0.add({ hours: 30 }),
        testOrder: false,
      },
    });
  });

  it('answers unknown on a refusal, a throw, or for any caller but the system', async () => {
    const refused = new FacadeDeliveredOrderFacts(
      ordering(() => Promise.resolve(err({ code: 'ordering.facts-unavailable' }))),
    );
    expect(await refused.read(system, request)).toEqual({ known: false });
    const throws = new FacadeDeliveredOrderFacts(ordering(() => Promise.reject(new Error('down'))));
    expect(await throws.read(system, request)).toEqual({ known: false });
    let asked = 0;
    const counted = new FacadeDeliveredOrderFacts(
      ordering(() => {
        asked += 1;
        return Promise.resolve(ok(facts));
      }),
    );
    expect(await counted.read(seller, request)).toEqual({ known: false });
    expect(asked).toBe(0);
  });

  it('records the cashback through the ledger, and says no on a refusal, a throw or a non-system caller', async () => {
    const cashback = {
      creditId: id<'PromotionCredit'>(5),
      orderId: facts.orderId,
      sellerOrderId: facts.sellerOrderId,
      sellerId: facts.sellerId,
      amount: 70n,
      currency,
      creditedAt: T0,
    };
    const calls: unknown[] = [];
    const ledger = (answer: () => Promise<unknown>) =>
      new FacadeSellerCashbackLedger({
        recordSellerCashback: (_c: CallContext, input: unknown) => {
          calls.push(input);
          return answer();
        },
      } as unknown as CommissionPayoutsFacade);
    expect(await ledger(() => Promise.resolve(ok('recorded'))).record(system, cashback)).toBe(true);
    expect(calls).toEqual([cashback]);
    expect(
      await ledger(() => Promise.resolve(ok('already-recorded'))).record(system, cashback),
    ).toBe(true);
    expect(
      await ledger(() =>
        Promise.resolve(err({ code: 'commission-payouts.ledger-inconsistent' })),
      ).record(system, cashback),
    ).toBe(false);
    expect(await ledger(() => Promise.reject(new Error('down'))).record(system, cashback)).toBe(
      false,
    );
    calls.length = 0;
    expect(await ledger(() => Promise.resolve(ok('recorded'))).record(seller, cashback)).toBe(
      false,
    );
    expect(calls).toEqual([]);
  });

  it('never reads more refunded goods than were charged', async () => {
    const adapter = new FacadeDeliveredOrderFacts(
      ordering(() =>
        Promise.resolve(ok({ ...facts, refundedGoods: 5000n, succeededRefundedGoods: 5000n })),
      ),
    );
    const read = await adapter.read(system, request);
    expect(read.known && read.value.goodsPaid.amount).toBe(0n);
    expect(read.known && read.value.goodsKeptSettled.amount).toBe(0n);
  });

  it('reads the payout release, and answers unknown on a refusal, a throw or a non-system caller', async () => {
    const anchor = {
      orderId: facts.orderId,
      sellerOrderId: facts.sellerOrderId,
      sellerId: facts.sellerId,
      eligibleAt: T0.add({ hours: 24 * 14 }),
    };
    let asked = 0;
    const anchors = (answer: () => Promise<unknown>) =>
      new FacadePayoutAnchors({
        sellerOrderPayoutAnchor: () => {
          asked += 1;
          return answer();
        },
      } as unknown as CommissionPayoutsFacade);
    expect(
      await anchors(() => Promise.resolve(ok(anchor))).anchorOf(system, facts.sellerOrderId),
    ).toEqual({
      known: true,
      value: { sellerId: facts.sellerId, eligibleAt: T0.add({ hours: 24 * 14 }) },
    });
    expect(
      await anchors(() =>
        Promise.resolve(err({ code: 'commission-payouts.not-anchored' })),
      ).anchorOf(system, facts.sellerOrderId),
    ).toEqual({ known: false });
    expect(
      await anchors(() => Promise.reject(new Error('down'))).anchorOf(system, facts.sellerOrderId),
    ).toEqual({ known: false });
    asked = 0;
    expect(
      await anchors(() => Promise.resolve(ok(anchor))).anchorOf(seller, facts.sellerOrderId),
    ).toEqual({ known: false });
    expect(asked).toBe(0);
  });
});
