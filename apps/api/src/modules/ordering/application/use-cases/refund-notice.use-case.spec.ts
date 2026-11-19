import { err, ok, money, parseId } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import { expectSystemOnly, openGate } from '../../../../../test/support/system-only-denial';
import { RefundNoticeQuery } from './refund-notice.use-case';

const ORDER = '01990000-0000-7000-8000-0000000000a1';
const OTHER_ORDER = '01990000-0000-7000-8000-0000000000a2';
const ACCOUNT = '01990000-0000-7000-8000-0000000000b1';
const REFUND = '01990000-0000-7000-8000-0000000000c1';

function id(value: string) {
  const parsed = parseId(value);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value;
}

function query(state: string, refundOrderId: string, currency: string) {
  const refund = {
    id: id(REFUND),
    orderId: id(refundOrderId),
    state,
    reason: 'item-unavailable',
    actor: { population: 'seller', accountId: id(ACCOUNT) },
    gross: 1250n,
    currency,
    lines: [{ quantity: 2 }, { quantity: 1 }],
  };
  const deps = {
    unitOfWork: { run: (_market: unknown, work: () => Promise<unknown>) => work() },
    refunds: { findById: () => Promise.resolve(refund) },
    orders: {
      findById: () => Promise.resolve({ id: id(ORDER), accountId: id(ACCOUNT) }),
    },
  };
  return new RefundNoticeQuery(openGate(), deps as never);
}

describe.each([
  ['AU', 'AUD'],
  ['ZZ', 'JPY'],
] as const)('ordering.refund-notice in market %s', (code, currency) => {
  const system = () =>
    testCallContext(testMarketContext(code, 'default'), 'system', 'refund-notice-0001');

  it('refuses a customer, a seller, an admin and an anonymous caller', async () => {
    const use = new RefundNoticeQuery(openGate(), undefined as never);
    await expectSystemOnly(code, (context) =>
      use.execute(context, { orderId: ORDER, refundId: REFUND }),
    );
  });

  it('answers the succeeded refund of the order: reason, amount and unit count', async () => {
    const result = await query('succeeded', ORDER, currency).execute(system(), {
      orderId: ORDER,
      refundId: REFUND,
    });
    expect(result).toEqual(
      ok({
        orderId: ORDER,
        accountId: ACCOUNT,
        refundId: REFUND,
        reason: 'item-unavailable',
        requestedBy: 'seller',
        amount: money(1250n, currency),
        units: 3,
      }),
    );
  });

  it.each([
    ['a refund not yet succeeded', 'reserved', ORDER],
    ['a refund of another order', 'succeeded', OTHER_ORDER],
  ])('answers not found for %s', async (_name, state, refundOrderId) => {
    const result = await query(state, refundOrderId, currency).execute(system(), {
      orderId: ORDER,
      refundId: REFUND,
    });
    expect(result).toEqual(err({ code: 'ordering.refund-not-found' }));
  });

  it('refuses ids that are not ids', async () => {
    const result = await query('succeeded', ORDER, currency).execute(system(), {
      orderId: 'nope',
      refundId: REFUND,
    });
    expect(result).toEqual(err({ code: 'validation.failed' }));
  });
});
