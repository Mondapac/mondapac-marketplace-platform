import { parseId } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { Temporal } from '@mondapac/shared-kernel';
import {
  parseRefundRequest,
  parseUnavailableRequest,
  planRefund,
  priceRefund,
  unavailableRequest,
  type RefundTarget,
} from './refund';

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
  fulfilment: 'to-ship',
  readyAt: null,
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
  succeededUnits: new Map(),
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
  lossBearer: 'seller' as const,
  lossReasonCode: null,
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
      request: {
        lines: [{ orderLineId: LINE_A, quantity: 2 }],
        shipping: 550n,
        reason: 'damaged',
        lossBearer: 'seller',
        lossReasonCode: null,
      },
    });
  });

  describe('the loss bearer', () => {
    const base = { lines: [{ orderLineId: LINE_A, quantity: 1 }], shippingAmount: undefined };
    const parse = (extra: { lossBearer?: unknown; lossReasonCode?: unknown }) =>
      parseRefundRequest({ ...base, reason: 'other', ...extra });

    it('defaults to the seller, with no reason code', () => {
      for (const extra of [{}, { lossBearer: null }, { lossBearer: 'seller' }]) {
        const parsed = parse(extra);
        expect(parsed.ok && [parsed.request.lossBearer, parsed.request.lossReasonCode]).toEqual([
          'seller',
          null,
        ]);
      }
    });

    it.each([
      'platform-error',
      'carrier-loss',
      'seller-unrecoverable',
      'fraud-loss',
      'goodwill',
      'other',
    ])('takes the platform with the code %s', (code) => {
      const parsed = parse({ lossBearer: 'platform', lossReasonCode: code });
      expect(parsed.ok && [parsed.request.lossBearer, parsed.request.lossReasonCode]).toEqual([
        'platform',
        code,
      ]);
    });

    it('needs a reason code exactly when the platform bears the loss', () => {
      const fields = (extra: { lossBearer?: unknown; lossReasonCode?: unknown }) => {
        const parsed = parse(extra);
        return parsed.ok ? [] : parsed.fields;
      };
      expect(fields({ lossBearer: 'platform' })).toEqual([
        { path: 'lossReasonCode', code: 'required' },
      ]);
      expect(fields({ lossBearer: 'platform', lossReasonCode: 'because' })).toEqual([
        { path: 'lossReasonCode', code: 'value' },
      ]);
      expect(fields({ lossReasonCode: 'goodwill' })).toEqual([
        { path: 'lossReasonCode', code: 'unexpected' },
      ]);
      expect(fields({ lossBearer: 'seller', lossReasonCode: 'goodwill' })).toEqual([
        { path: 'lossReasonCode', code: 'unexpected' },
      ]);
      expect(fields({ lossBearer: 'customer' })).toEqual([{ path: 'lossBearer', code: 'value' }]);
      expect(fields({ lossBearer: 7, lossReasonCode: 'goodwill' })).toEqual([
        { path: 'lossBearer', code: 'value' },
      ]);
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
      lines: [
        {
          orderLineId: LINE_A,
          quantity: 1,
          lineQuantity: 3,
          unitsBefore: 0,
          gross: 1100n,
          tax: 100n,
        },
      ],
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

describe('a seller marks units unavailable (decision 6)', () => {
  it('never takes the seller reason in an admin request', () => {
    expect(
      parseRefundRequest({
        lines: [{ orderLineId: LINE_A, quantity: 1 }],
        shippingAmount: null,
        reason: 'item-unavailable',
      }),
    ).toEqual({ ok: false, fields: [{ path: 'reason', code: 'value' }] });
  });

  it('takes only lines with their units, never an amount or a reason', () => {
    expect(parseUnavailableRequest({ lines: [{ orderLineId: LINE_A, quantity: 2 }] })).toEqual({
      ok: true,
      lines: [{ orderLineId: LINE_A, quantity: 2 }],
    });
    expect(parseUnavailableRequest({ lines: [] })).toEqual({
      ok: false,
      fields: [{ path: 'lines', code: 'required' }],
    });
    expect(
      parseUnavailableRequest({
        lines: [
          { orderLineId: LINE_A, quantity: 1 },
          { orderLineId: LINE_A, quantity: 0 },
        ],
      }),
    ).toEqual({
      ok: false,
      fields: [
        { path: 'lines.1.orderLineId', code: 'duplicate' },
        { path: 'lines.1.quantity', code: 'range' },
      ],
    });
    expect(parseUnavailableRequest({ lines: 'all' })).toEqual({
      ok: false,
      fields: [{ path: 'lines', code: 'range' }],
    });
  });

  it('refunds the units borne by the seller, keeping the shipping while something is left', () => {
    expect(unavailableRequest(inclusive, [{ orderLineId: LINE_A, quantity: 2 }])).toEqual({
      ok: true,
      request: {
        lines: [{ orderLineId: LINE_A, quantity: 2 }],
        shipping: 0n,
        reason: 'item-unavailable',
        lossBearer: 'seller',
        lossReasonCode: null,
      },
    });
  });

  it('gives the shipping fee not yet refunded back once nothing is left to send', () => {
    const all = unavailableRequest(inclusive, [{ orderLineId: LINE_A, quantity: 3 }]);
    expect(all.ok && all.request.shipping).toBe(550n);
    const rest = unavailableRequest(
      { ...inclusive, refundedUnits: new Map([[LINE_A, 2]]), refundedShipping: 150n },
      [{ orderLineId: LINE_A, quantity: 1 }],
    );
    expect(rest.ok && rest.request.shipping).toBe(400n);
    // Tax-exclusive shipping goes back with its tax on top.
    const zz = unavailableRequest(exclusive, [{ orderLineId: LINE_B, quantity: 2 }]);
    expect(zz.ok && zz.request.shipping).toBe(575n);
    // A fee placed before its tax was recorded is not guessed: the units go back alone.
    const old = unavailableRequest({ ...inclusive, shippingTax: null }, [
      { orderLineId: LINE_A, quantity: 3 },
    ]);
    expect(old.ok && old.request.shipping).toBe(0n);
  });

  it('prices the whole seller order back to exactly what it took', () => {
    const all = unavailableRequest(inclusive, [{ orderLineId: LINE_A, quantity: 3 }]);
    if (!all.ok) throw new Error('refused');
    const planned = planRefund(inclusive, all.request);
    if (!planned.ok) throw new Error('refused');
    const refund = priceRefund(
      inclusive,
      planned.plan,
      { lines: [300n], charges: [50n] },
      {
        ...details,
        reason: 'item-unavailable',
        actor: { population: 'seller', accountId: id<'Account'>(7) },
      },
    );
    expect(refund?.gross).toBe(3850n);
    expect(refund?.lossBearer).toBe('seller');
  });

  it('refuses once the seller order is ready, shipped or delivered', () => {
    const at = Temporal.Instant.from('2026-10-19T11:00:00Z');
    const lines = [{ orderLineId: LINE_A, quantity: 1 }];
    const conflict = { ok: false, error: { code: 'ordering.fulfilment-conflict' } };
    expect(unavailableRequest({ ...inclusive, readyAt: at }, lines)).toEqual(conflict);
    expect(unavailableRequest({ ...inclusive, fulfilment: 'shipped' }, lines)).toEqual(conflict);
    expect(unavailableRequest({ ...inclusive, fulfilment: 'delivered' }, lines)).toEqual(conflict);
  });
});
