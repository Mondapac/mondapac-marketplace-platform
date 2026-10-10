import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { heldByItem, SellableCalculator, type HeldLine } from './sellable-calculator';

const NOW = Temporal.Instant.from('2026-10-09T01:00:00Z');
const item = (n: number) =>
  `0199c1a0-0000-7000-8000-${String(n).padStart(12, '0')}` as Id<'StockItem'>;

const line = (over: Partial<HeldLine>): HeldLine => ({
  stockItemId: item(1),
  status: 'active',
  expiresAt: NOW.add({ minutes: 5 }),
  quantity: 2,
  ...over,
});

describe('SellableCalculator (design 4.1)', () => {
  it('counts active unexpired lines and committed lines, nothing else', () => {
    const held = heldByItem(
      [
        line({ quantity: 2 }),
        line({ status: 'committed', expiresAt: NOW.subtract({ hours: 24 }), quantity: 3 }),
        line({ status: 'released', quantity: 7 }),
        line({ status: 'expired', quantity: 7 }),
        line({ status: 'fulfilled', quantity: 7 }),
        line({ status: 'cancelled', quantity: 7 }),
      ],
      NOW,
    );

    expect(held.get(item(1))).toBe(5);
  });

  it('derives expiry at read: a line stops counting at its expiry instant, status still active', () => {
    const lines = [line({ expiresAt: NOW.add({ seconds: 1 }) })];

    expect(heldByItem(lines, NOW).get(item(1))).toBe(2);
    expect(heldByItem(lines, NOW.add({ seconds: 1 })).get(item(1))).toBeUndefined();
  });

  it('is the largest sellable of the non-retired sources', () => {
    const held = heldByItem([line({ quantity: 4 })], NOW);

    expect(
      SellableCalculator.ofSellUnit([
        { onHand: 5, held: held.get(item(1)) ?? 0, retired: false },
        { onHand: 3, held: 0, retired: false },
        { onHand: 50, held: 0, retired: true },
      ]),
    ).toBe(3);
  });
});
