import type { Id } from '@mondapac/shared-kernel';
import { notStarted, parseCancelRequest, planCancel, type CancelPart } from './cancel';
import type { RefundTarget } from './refund';
import { parseNoteBody } from './admin-order-note';

const line = (id: string, quantity: number) => ({
  id: id as Id<'OrderLine'>,
  quantity,
  unitAmount: 1000n,
  taxInclusive: true,
  taxRateBps: 1000,
  taxAmount: 91n * BigInt(quantity),
});

const target = (over: Partial<RefundTarget> = {}): RefundTarget => ({
  orderId: 'o' as Id<'Order'>,
  sellerOrderId: 's1' as Id<'SellerOrder'>,
  sellerId: 'seller' as Id<'Seller'>,
  currency: 'AUD',
  orderStatus: 'confirmed',
  paymentState: 'captured',
  paymentIntentId: 'pi_1',
  shipping: 500n,
  shippingTax: 45n,
  shippingTaxRateBps: 1000,
  shippingTaxInclusive: true,
  total: 3500n,
  refunded: 0n,
  pending: false,
  lines: [line('l1', 2), line('l2', 1)],
  refundedUnits: new Map(),
  succeededUnits: new Map(),
  refundedShipping: 0n,
  ...over,
});

const part = (over: Partial<RefundTarget> = {}, more: Partial<CancelPart> = {}): CancelPart => ({
  target: target(over),
  fulfilment: 'to-ship',
  ready: false,
  ...more,
});

const request = { reason: 'other', lossBearer: 'seller', lossReasonCode: null } as const;

describe('planCancel', () => {
  it('asks for every unit and the whole fee of each seller order', () => {
    const planned = planCancel(
      [part(), part({ sellerOrderId: 's2' as Id<'SellerOrder'> })],
      request,
    );
    expect(planned.ok && planned.refunds.map((r) => r.request)).toEqual([
      {
        lines: [
          { orderLineId: 'l1', quantity: 2 },
          { orderLineId: 'l2', quantity: 1 },
        ],
        shipping: 500n,
        ...request,
      },
      {
        lines: [
          { orderLineId: 'l1', quantity: 2 },
          { orderLineId: 'l2', quantity: 1 },
        ],
        shipping: 500n,
        ...request,
      },
    ]);
  });

  it('asks only for what earlier refunds left, and skips a part refunded in full', () => {
    const planned = planCancel(
      [
        part({
          refundedUnits: new Map([['l1' as Id<'OrderLine'>, 1]]),
          refundedShipping: 200n,
        }),
        part({
          sellerOrderId: 's2' as Id<'SellerOrder'>,
          refundedUnits: new Map([
            ['l1' as Id<'OrderLine'>, 2],
            ['l2' as Id<'OrderLine'>, 1],
          ]),
          refundedShipping: 500n,
        }),
      ],
      request,
    );
    expect(planned.ok && planned.refunds.map((r) => [r.target.sellerOrderId, r.request])).toEqual([
      [
        's1',
        {
          lines: [
            { orderLineId: 'l1', quantity: 1 },
            { orderLineId: 'l2', quantity: 1 },
          ],
          shipping: 300n,
          ...request,
        },
      ],
    ]);
  });

  it('adds the tax on top of a fee that excludes it', () => {
    const planned = planCancel([part({ shippingTaxInclusive: false })], request);
    expect(planned.ok && planned.refunds[0]!.request.shipping).toBe(545n);
  });

  it('refuses once any seller started, an unpaid order, a pending refund, and nothing left', () => {
    expect(planCancel([part(), part({}, { ready: true })], request)).toEqual({
      ok: false,
      error: { code: 'ordering.cancel-too-late' },
    });
    expect(planCancel([part({}, { fulfilment: 'shipped' })], request)).toMatchObject({
      error: { code: 'ordering.cancel-too-late' },
    });
    expect(planCancel([part({ paymentState: 'authorised' })], request)).toMatchObject({
      error: { code: 'ordering.refund-not-allowed' },
    });
    expect(planCancel([part({ orderStatus: 'cancelled' })], request)).toMatchObject({
      error: { code: 'ordering.refund-not-allowed' },
    });
    expect(planCancel([], request)).toMatchObject({
      error: { code: 'ordering.refund-not-allowed' },
    });
    expect(planCancel([part({ pending: true })], request)).toMatchObject({
      error: { code: 'ordering.refund-in-progress' },
    });
    expect(
      planCancel(
        [
          part({
            shipping: 0n,
            refundedUnits: new Map([
              ['l1' as Id<'OrderLine'>, 2],
              ['l2' as Id<'OrderLine'>, 1],
            ]),
          }),
        ],
        request,
      ),
    ).toMatchObject({ error: { code: 'ordering.cancel-nothing-left' } });
  });

  it('treats only a to-ship part not marked ready as not started', () => {
    expect(notStarted({ fulfilment: 'to-ship', ready: false })).toBe(true);
    expect(notStarted({ fulfilment: 'to-ship', ready: true })).toBe(false);
    expect(notStarted({ fulfilment: 'delivered', ready: false })).toBe(false);
  });
});

describe('parseCancelRequest', () => {
  it('defaults the loss to the seller and needs a code exactly for the platform', () => {
    expect(parseCancelRequest({ reason: 'damaged' })).toEqual({
      ok: true,
      request: { reason: 'damaged', lossBearer: 'seller', lossReasonCode: null },
    });
    expect(
      parseCancelRequest({ reason: 'other', lossBearer: 'platform', lossReasonCode: 'goodwill' }),
    ).toEqual({
      ok: true,
      request: { reason: 'other', lossBearer: 'platform', lossReasonCode: 'goodwill' },
    });
    expect(parseCancelRequest({ reason: 'other', lossBearer: 'platform' })).toEqual({
      ok: false,
      fields: [{ path: 'lossReasonCode', code: 'required' }],
    });
    expect(parseCancelRequest({ reason: 'other', lossReasonCode: 'goodwill' })).toEqual({
      ok: false,
      fields: [{ path: 'lossReasonCode', code: 'unexpected' }],
    });
    expect(
      parseCancelRequest({ reason: 'nope', lossBearer: 'customer', lossReasonCode: 'goodwill' }),
    ).toEqual({
      ok: false,
      fields: [
        { path: 'reason', code: 'value' },
        { path: 'lossBearer', code: 'value' },
      ],
    });
  });
});

describe('parseNoteBody', () => {
  it('trims, makes line breaks plain, counts characters and refuses hidden ones', () => {
    expect(parseNoteBody(' a\r\nb\rc ')).toEqual({ ok: true, body: 'a\nb\nc' });
    expect(parseNoteBody('می‌خواهد\tok')).toEqual({ ok: true, body: 'می‌خواهد\tok' });
    expect(parseNoteBody('😀'.repeat(2000)).ok).toBe(true);
    expect(parseNoteBody('😀'.repeat(2001))).toEqual({
      ok: false,
      fields: [{ path: 'body', code: 'too-long' }],
    });
    for (const hidden of ['\u0007', '‮', '⁦', ' ', '\u0085']) {
      expect(parseNoteBody(`a${hidden}b`)).toEqual({
        ok: false,
        fields: [{ path: 'body', code: 'format' }],
      });
    }
    expect(parseNoteBody('')).toEqual({ ok: false, fields: [{ path: 'body', code: 'required' }] });
    expect(parseNoteBody(null)).toEqual({ ok: false, fields: [{ path: 'body', code: 'type' }] });
  });
});
