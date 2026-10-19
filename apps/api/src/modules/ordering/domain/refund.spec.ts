import { parseId } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { Temporal } from '@mondapac/shared-kernel';
import { parseRefundRequest, planRefund, priceRefund, type RefundTarget } from './refund';

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const LINE_A = id<'OrderLine'>(0xa);
const LINE_B = id<'OrderLine'>(0xb);

/** AU-like: 3 × $11.00 GST-inclusive ($3.00 tax), delivery $5.50 inclusive ($0.50 tax). */
const inclusive: RefundTarget = {
  orderId: id<'Order'>(1),
  sellerOrderId: id<'SellerOrder'>(2),
  sellerId: id<'Seller'>(3),
  currency: 'AUD',
  orderStatus: 'confirmed',
  paymentState: 'captured',
  paymentIntentId: 'pi_test_1',
  shipping: 550n,
  shippingTax: 50n,
  shippingTaxRateBps: 1000,
  shippingTaxInclusive: true,
  total: 3850n,
  refunded: 0n,
  pending: false,
  lines: [
    {
      id: LINE_A,
      quantity: 3,
      unitAmount: 1100n,
      taxInclusive: true,
      taxRateBps: 1000,
      taxAmount: 300n,
    },
  ],
  refundedUnits: new Map(),
  refundedShipping: 0n,
};

/** ZZ-like: 2 × 1000 before tax (301, as frozen), delivery 500 plus 75 tax. */
const exclusive: RefundTarget = {
  ...inclusive,
  currency: 'JPY',
  shipping: 500n,
  shippingTax: 75n,
  shippingTaxRateBps: 1500,
  shippingTaxInclusive: false,
  total: 2876n,
  lines: [
    {
      id: LINE_B,
      quantity: 2,
      unitAmount: 1000n,
      taxInclusive: false,
      taxRateBps: 1500,
      taxAmount: 301n,
    },
  ],
};

const details = {
  id: id<'Refund'>(9),
  reason: 'damaged' as const,
  actor: { population: 'admin' as const, accountId: id<'Account'>(8) },
  stripeIdempotencyKey: 'refund-9',
  requestedAt: Temporal.Instant.from('2026-10-19T10:00:00Z'),
};

describe('parseRefundRequest', () => {
  it('takes lines, an optional shipping amount and a reason', () => {
    expect(
      parseRefundRequest({
        lines: [{ orderLineId: LINE_A, quantity: 2 }],
        shippingAmount: '550',
        reason: 'damaged',
      }),
    ).toEqual({
      ok: true,
      request: { lines: [{ orderLineId: LINE_A, quantity: 2 }], shipping: 550n, reason: 'damaged' },
    });
  });

  it('refuses an empty refund, a repeated line, a bad quantity, amount or reason', () => {
    const fields = (input: Parameters<typeof parseRefundRequest>[0]) => {
      const parsed = parseRefundRequest(input);
      return parsed.ok ? [] : parsed.fields;
    };
    expect(fields({ lines: [], shippingAmount: undefined, reason: 'other' })).toEqual([
      { path: 'lines', code: 'required' },
    ]);
    expect(
      fields({
        lines: [
          { orderLineId: LINE_A, quantity: 1 },
          { orderLineId: LINE_A, quantity: 0 },
        ],
        shippingAmount: '-5',
        reason: 'because',
      }),
    ).toEqual([
      { path: 'lines.1.orderLineId', code: 'duplicate' },
      { path: 'lines.1.quantity', code: 'range' },
      { path: 'shippingAmount', code: 'format' },
      { path: 'reason', code: 'value' },
    ]);
  });
});

describe('planRefund and priceRefund', () => {
  const price = (
    target: RefundTarget,
    lines: { orderLineId: Id<'OrderLine'>; quantity: number }[],
    shipping: bigint,
    reversed: { lines: bigint[]; charges: bigint[] },
  ) => {
    const planned = planRefund(target, { lines, shipping, reason: 'damaged' });
    if (!planned.ok) throw new Error(planned.error.code);
    return { plan: planned.plan, refund: priceRefund(target, planned.plan, reversed, details) };
  };

  it('gives back the unit price of a tax-inclusive line (tax inside) and the shipping part', () => {
    const { plan, refund } = price(inclusive, [{ orderLineId: LINE_A, quantity: 1 }], 275n, {
      lines: [100n],
      charges: [25n],
    });
    expect(plan.lines).toEqual([{ line: inclusive.lines[0], unitsBefore: 0, units: 1 }]);
    expect(plan.shipping).toEqual({ gross: 550n, tax: 50n, before: 0n, after: 275n });
    expect(refund).toMatchObject({
      gross: 1100n + 275n,
      tax: 125n,
      shipping: { gross: 275n, tax: 25n, taxRateBps: 1000, taxInclusive: true },
      lines: [{ orderLineId: LINE_A, quantity: 1, unitsBefore: 0, gross: 1100n, tax: 100n }],
      state: 'pending',
    });
  });

  it('adds the reversed tax to a tax-exclusive line and to tax-exclusive shipping', () => {
    const { plan, refund } = price(exclusive, [{ orderLineId: LINE_B, quantity: 2 }], 575n, {
      lines: [301n],
      charges: [75n],
    });
    // The shipping fee as paid is 500 + 75.
    expect(plan.shipping).toEqual({ gross: 575n, tax: 75n, before: 0n, after: 575n });
    expect(refund).toMatchObject({ gross: 2000n + 301n + 575n, tax: 376n });
    expect(refund!.gross).toBe(exclusive.total);
  });

  it('counts what earlier refunds gave back and refuses more than is left', () => {
    const after = { ...inclusive, refundedUnits: new Map([[LINE_A, 2]]), refundedShipping: 550n };
    expect(
      planRefund(after, {
        lines: [{ orderLineId: LINE_A, quantity: 2 }],
        shipping: 1n,
        reason: 'other',
      }),
    ).toEqual({
      ok: false,
      error: {
        code: 'ordering.refund-exceeds',
        fields: [
          { path: 'lines.0.quantity', code: 'exceeds' },
          { path: 'shippingAmount', code: 'exceeds' },
        ],
      },
    });
    const planned = planRefund(after, {
      lines: [{ orderLineId: LINE_A, quantity: 1 }],
      shipping: 0n,
      reason: 'other',
    });
    expect(planned.ok && planned.plan.lines[0]!.unitsBefore).toBe(2);
  });

  it('refuses an unpaid order, a pending refund, an unknown line and a line without frozen tax', () => {
    const one = [{ orderLineId: LINE_A, quantity: 1 }];
    const code = (target: RefundTarget, lines = one) => {
      const planned = planRefund(target, { lines, shipping: 0n, reason: 'other' });
      return planned.ok ? 'ok' : planned.error.code;
    };
    expect(code({ ...inclusive, orderStatus: 'pending-payment', paymentState: 'none' })).toBe(
      'ordering.refund-not-allowed',
    );
    expect(code({ ...inclusive, paymentIntentId: null })).toBe('ordering.refund-not-allowed');
    expect(code({ ...inclusive, pending: true })).toBe('ordering.refund-in-progress');
    expect(code(inclusive, [{ orderLineId: LINE_B, quantity: 1 }])).toBe('ordering.refund-exceeds');
    expect(
      code({
        ...inclusive,
        lines: [{ ...inclusive.lines[0]!, taxAmount: null, taxRateBps: null }],
      }),
    ).toBe('ordering.refund-tax-unknown');
    expect(
      planRefund(
        { ...inclusive, shippingTax: null, shippingTaxInclusive: null, shippingTaxRateBps: null },
        { lines: [], shipping: 100n, reason: 'other' },
      ),
    ).toEqual({ ok: false, error: { code: 'ordering.refund-tax-unknown' } });
  });

  it('never prices past what the seller order took', () => {
    const planned = planRefund(inclusive, {
      lines: [{ orderLineId: LINE_A, quantity: 1 }],
      shipping: 0n,
      reason: 'other',
    });
    if (!planned.ok) throw new Error('plan');
    expect(
      priceRefund(
        { ...inclusive, refunded: 3000n },
        planned.plan,
        { lines: [100n], charges: [] },
        details,
      ),
    ).toBeNull();
  });
});
