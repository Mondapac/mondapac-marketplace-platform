import { Temporal } from '@mondapac/shared-kernel';
import { bookingMomentOf, DELIVERY_METHODS, parseDeliveryChoices } from './delivery-method';
import { markNeedsAttention, markReady, type SellerOrder } from './order';

// The buyer's delivery method per seller order and the seller's "ready" step. Pure rules, no
// Market: the flows that use them run on AU and ZZ in ordering-use-cases.spec.ts.

const NOW = Temporal.Instant.from('2026-10-25T01:00:00Z');
const START = '2026-10-26T01:00:00Z';
const END = '2026-10-26T03:00:00Z';
const SELLER = '01990000-0000-7000-8000-0000000000b1';

const parse = (entry: unknown) => parseDeliveryChoices({ [SELLER]: entry }, NOW);

describe('delivery methods', () => {
  it('has the four methods the buyer can choose, in one place', () => {
    expect(DELIVERY_METHODS).toEqual(['pickup', 'instant', 'same_day', 'scheduled']);
  });

  it('books scheduled at payment, instant and same day when ready, and pickup never', () => {
    expect(bookingMomentOf('scheduled')).toBe('payment');
    expect(bookingMomentOf('instant')).toBe('ready');
    expect(bookingMomentOf('same_day')).toBe('ready');
    expect(bookingMomentOf('pickup')).toBe('never');
  });
});

describe('parseDeliveryChoices', () => {
  it('takes no choice as no choices', () => {
    expect(parseDeliveryChoices(undefined, NOW)).toEqual({ ok: true, choices: new Map() });
    expect(parseDeliveryChoices(null, NOW)).toEqual({ ok: true, choices: new Map() });
  });

  it.each(['pickup', 'instant', 'same_day'])('takes %s with no window', (method) => {
    expect(parse({ method })).toEqual({
      ok: true,
      choices: new Map([[SELLER, { method, window: null }]]),
    });
  });

  it('takes a scheduled window as UTC instants, whatever offset it is written in', () => {
    const result = parse({
      method: 'scheduled',
      windowStart: '2026-10-26T11:00:00+10:00',
      windowEnd: END,
    });
    expect(result.ok && result.choices.get(SELLER)?.window?.start.toString()).toBe(START);
    expect(result.ok && result.choices.get(SELLER)?.window?.end.toString()).toBe(END);
  });

  it('refuses by path: an unknown method, a missing or past window, an empty window, a stray field', () => {
    const path = `deliveryMethods.${SELLER}`;
    const fields = (entry: unknown) => {
      const result = parse(entry);
      return result.ok ? 'ok' : result.fields;
    };
    expect(fields({ method: 'drone' })).toEqual([{ path: `${path}.method`, code: 'value' }]);
    expect(fields({ method: 'scheduled', windowStart: START })).toEqual([
      { path: `${path}.windowEnd`, code: 'format' },
    ]);
    expect(fields({ method: 'scheduled', windowStart: 'tomorrow', windowEnd: END })).toEqual([
      { path: `${path}.windowStart`, code: 'format' },
    ]);
    expect(fields({ method: 'scheduled', windowStart: NOW.toString(), windowEnd: END })).toEqual([
      { path: `${path}.windowStart`, code: 'past' },
    ]);
    expect(fields({ method: 'scheduled', windowStart: END, windowEnd: START })).toEqual([
      { path: `${path}.windowEnd`, code: 'range' },
    ]);
    expect(fields({ method: 'pickup', windowStart: START })).toEqual([
      { path: `${path}.window`, code: 'not-allowed' },
    ]);
    expect(fields({ method: 'pickup', sellerId: 'x' })).toEqual([
      { path: `${path}.field`, code: 'unknown-field' },
    ]);
    expect(fields('pickup')).toEqual([{ path, code: 'type' }]);
    expect(parseDeliveryChoices([], NOW)).toEqual({
      ok: false,
      fields: [{ path: 'deliveryMethods', code: 'type' }],
    });
  });
});

const sellerOrder = (patch: Partial<SellerOrder> = {}): SellerOrder => ({
  id: '01990000-0000-7000-8000-0000000000c1' as SellerOrder['id'],
  sellerId: SELLER as SellerOrder['sellerId'],
  subtotal: 1000n,
  shipping: 0n,
  shippingTaxRateBps: null,
  shippingTax: null,
  shippingTaxInclusive: null,
  total: 1000n,
  fulfilment: 'to-ship',
  carrier: null,
  trackingRef: null,
  shippedAt: null,
  deliveredAt: null,
  inventoryRecordedAt: null,
  ledgerState: 'pending',
  deliveryMethod: 'instant',
  deliveryWindow: null,
  readyAt: null,
  deliveryAttention: null,
  ...patch,
});

describe('markReady', () => {
  it('sets the ready time on a to-ship order and changes nothing else', () => {
    const ready = markReady(sellerOrder(), NOW);
    expect(ready).toEqual(sellerOrder({ readyAt: NOW }));
  });

  it('is refused once ready, shipped or delivered (null), so it happens once', () => {
    expect(markReady(sellerOrder({ readyAt: NOW }), NOW)).toBeNull();
    expect(
      markReady(sellerOrder({ fulfilment: 'shipped', carrier: 'C', shippedAt: NOW }), NOW),
    ).toBeNull();
  });
});

describe('markNeedsAttention', () => {
  it('records no-carrier once, on a to-ship order', () => {
    const flagged = markNeedsAttention(sellerOrder(), 'no-carrier');
    expect(flagged?.deliveryAttention).toBe('no-carrier');
    expect(markNeedsAttention(flagged!, 'no-carrier')).toBeNull();
    expect(
      markNeedsAttention(
        sellerOrder({ fulfilment: 'shipped', carrier: 'C', shippedAt: NOW }),
        'no-carrier',
      ),
    ).toBeNull();
  });
});
