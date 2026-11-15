import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { linesRefundedInFull } from './refund';
import {
  SELLER_SHIP_TO_RETENTION,
  SELLER_SHIP_TO_RETENTION_UNDELIVERED,
  sellerMaySeeShipTo,
  type ShipToRetentionFacts,
} from './ship-to-retention';

const SHIPPED = Temporal.Instant.from('2026-09-20T03:00:00Z');
const DELIVERED = Temporal.Instant.from('2026-10-01T03:00:00Z');
const HOUR = (n: number) => ({ hours: n });

const toShip: ShipToRetentionFacts = {
  fulfilment: 'to-ship',
  shippedAt: null,
  deliveredAt: null,
  cancelledOrRefundedInFull: false,
};
const shipped: ShipToRetentionFacts = { ...toShip, fulfilment: 'shipped', shippedAt: SHIPPED };
const delivered: ShipToRetentionFacts = {
  ...shipped,
  fulfilment: 'delivered',
  deliveredAt: DELIVERED,
};

describe('sellerMaySeeShipTo (owner decisions 2026-11-14 and 2026-11-15)', () => {
  it('keeps the address 30 days after delivery and 60 days after an undelivered shipment', () => {
    expect(SELLER_SHIP_TO_RETENTION.total({ unit: 'hours' })).toBe(30 * 24);
    expect(SELLER_SHIP_TO_RETENTION_UNDELIVERED.total({ unit: 'hours' })).toBe(60 * 24);
  });

  it('shows the address of an order not shipped yet, whatever the time', () => {
    expect(sellerMaySeeShipTo(toShip, SHIPPED.add(HOUR(24 * 365)))).toBe(true);
  });

  it('shows a shipped, undelivered order until 60 days after shipping, then withholds it', () => {
    expect(sellerMaySeeShipTo(shipped, SHIPPED)).toBe(true);
    expect(sellerMaySeeShipTo(shipped, SHIPPED.add(HOUR(60 * 24 - 1)))).toBe(true);
    const justBefore = SHIPPED.add(HOUR(60 * 24)).subtract({ milliseconds: 1 });
    expect(sellerMaySeeShipTo(shipped, justBefore)).toBe(true);
    expect(sellerMaySeeShipTo(shipped, SHIPPED.add(HOUR(60 * 24)))).toBe(false);
    expect(sellerMaySeeShipTo(shipped, SHIPPED.add(HOUR(60 * 24 * 5)))).toBe(false);
  });

  it('shows a delivered order until 30 days after delivery, then withholds it', () => {
    expect(sellerMaySeeShipTo(delivered, DELIVERED)).toBe(true);
    expect(sellerMaySeeShipTo(delivered, DELIVERED.add(HOUR(30 * 24 - 1)))).toBe(true);
    const justBefore = DELIVERED.add(HOUR(30 * 24)).subtract({ milliseconds: 1 });
    expect(sellerMaySeeShipTo(delivered, justBefore)).toBe(true);
    expect(sellerMaySeeShipTo(delivered, DELIVERED.add(HOUR(30 * 24)))).toBe(false);
  });

  it('counts a delivered order from delivery, not from the shipment 60-day limit', () => {
    // Shipped 11 days before delivery: 29 days after delivery is 40 days after shipping (shown);
    // a delivery late after a long shipment still gets its own 30 days.
    expect(sellerMaySeeShipTo(delivered, DELIVERED.add(HOUR(29 * 24)))).toBe(true);
    const late = { ...delivered, deliveredAt: SHIPPED.add(HOUR(59 * 24)) };
    expect(sellerMaySeeShipTo(late, SHIPPED.add(HOUR(80 * 24)))).toBe(true);
  });

  it('withholds it for a shipped or delivered order missing its instant (fail closed)', () => {
    expect(sellerMaySeeShipTo({ ...shipped, shippedAt: null }, SHIPPED)).toBe(false);
    expect(sellerMaySeeShipTo({ ...delivered, deliveredAt: null }, DELIVERED)).toBe(false);
    expect(
      sellerMaySeeShipTo({ ...delivered, shippedAt: null, deliveredAt: null }, DELIVERED),
    ).toBe(false);
  });

  it('withholds it at once when the seller order was cancelled or refunded in full', () => {
    for (const facts of [toShip, shipped, delivered]) {
      expect(sellerMaySeeShipTo({ ...facts, cancelledOrRefundedInFull: true }, SHIPPED)).toBe(
        false,
      );
    }
  });
});

describe('linesRefundedInFull (the seller order has nothing left to send)', () => {
  const id = (n: number): Id<'OrderLine'> => {
    const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
    if (!parsed.ok) throw new Error('bad id');
    return parsed.value as Id<'OrderLine'>;
  };
  const A = id(0xa);
  const B = id(0xb);
  const lines = [
    { lineId: A, quantity: 2 },
    { lineId: B, quantity: 1 },
  ];
  const refund = (
    state: 'pending' | 'succeeded' | 'failed',
    units: [Id<'OrderLine'>, number][],
  ) => ({
    state,
    lines: units.map(([orderLineId, quantity]) => ({ orderLineId, quantity })),
  });

  it('is false with no refund and with a partial refund', () => {
    expect(linesRefundedInFull(lines, [])).toBe(false);
    expect(linesRefundedInFull(lines, [refund('succeeded', [[A, 2]])])).toBe(false);
    expect(
      linesRefundedInFull(lines, [
        refund('succeeded', [
          [A, 1],
          [B, 1],
        ]),
      ]),
    ).toBe(false);
  });

  it('is true once refunds not failed cover every unit, across several refunds', () => {
    expect(
      linesRefundedInFull(lines, [
        refund('succeeded', [
          [A, 2],
          [B, 1],
        ]),
      ]),
    ).toBe(true);
    expect(
      linesRefundedInFull(lines, [refund('pending', [[A, 2]]), refund('succeeded', [[B, 1]])]),
    ).toBe(true);
  });

  it('ignores failed refunds: nothing went back', () => {
    expect(
      linesRefundedInFull(lines, [
        refund('failed', [
          [A, 2],
          [B, 1],
        ]),
      ]),
    ).toBe(false);
  });

  it('is false for a seller order without lines (nothing to judge)', () => {
    expect(linesRefundedInFull([], [refund('succeeded', [])])).toBe(false);
  });
});
