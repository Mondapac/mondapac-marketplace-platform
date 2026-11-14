import { Temporal } from '@mondapac/shared-kernel';
import { SELLER_SHIP_TO_RETENTION, sellerMaySeeShipTo } from './ship-to-retention';

const DELIVERED = Temporal.Instant.from('2026-10-01T03:00:00Z');

describe('sellerMaySeeShipTo (owner decision 2026-11-14)', () => {
  it('keeps the address for 30 days after delivery', () => {
    expect(SELLER_SHIP_TO_RETENTION.total({ unit: 'hours' })).toBe(30 * 24);
  });

  it('shows the address before delivery, whatever the time', () => {
    expect(sellerMaySeeShipTo(null, DELIVERED.add({ hours: 24 * 365 }))).toBe(true);
  });

  it('shows it until just before 30 days have passed since delivery', () => {
    expect(sellerMaySeeShipTo(DELIVERED, DELIVERED)).toBe(true);
    expect(sellerMaySeeShipTo(DELIVERED, DELIVERED.add({ hours: 30 * 24 - 1 }))).toBe(true);
    const justBefore = DELIVERED.add({ hours: 30 * 24 }).subtract({ milliseconds: 1 });
    expect(sellerMaySeeShipTo(DELIVERED, justBefore)).toBe(true);
  });

  it('withholds it from exactly 30 days after delivery on', () => {
    expect(sellerMaySeeShipTo(DELIVERED, DELIVERED.add({ hours: 30 * 24 }))).toBe(false);
    expect(sellerMaySeeShipTo(DELIVERED, DELIVERED.add({ hours: 30 * 24 * 12 }))).toBe(false);
  });
});
