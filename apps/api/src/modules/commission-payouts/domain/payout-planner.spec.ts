import { Temporal } from '@mondapac/shared-kernel';
import { planPayout, type PlannerHold, type PlannerItem } from './payout-planner';

// The planner is pure, so its rules are checked as properties over generated cases (a small
// seeded generator, mulberry32, so a failing case replays from its seed; fast-check is not a
// dependency of this repository) and as worked examples.

const NOW = Temporal.Instant.from('2026-10-27T00:00:00Z');
const hours = (n: number): Temporal.Instant => NOW.add({ hours: n });

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const between = (next: () => number, low: number, high: number): number =>
  low + Math.floor(next() * (high - low + 1));

const ORDERS = ['so-1', 'so-2', 'so-3', 'so-4'];

interface Case {
  readonly items: PlannerItem[];
  readonly holds: PlannerHold[];
  readonly receivable: bigint;
  readonly minimumMinor: bigint;
}

function generate(seed: number): Case {
  const next = random(seed);
  const items: PlannerItem[] = Array.from({ length: between(next, 0, 12) }, (_, index) => ({
    id: `item-${index}`,
    sellerOrderId: next() < 0.1 ? null : ORDERS[between(next, 0, ORDERS.length - 1)]!,
    // Mostly positive, sometimes zero or negative (never eligible).
    amount: BigInt(between(next, -200, 20_000)),
    // Past, exactly now, future, or not anchored yet.
    eligibleAt: next() < 0.15 ? null : hours(between(next, -100, 100)),
  }));
  const holds: PlannerHold[] = [];
  if (next() < 0.2) holds.push({ sellerOrderId: null });
  for (const order of ORDERS) if (next() < 0.25) holds.push({ sellerOrderId: order });
  return {
    items,
    holds,
    receivable: BigInt(between(next, -500, 30_000)),
    minimumMinor: BigInt(between(next, 1, 8_000)),
  };
}

const plan = (c: Case, now = NOW) => planPayout({ ...c, now });
const SEEDS = Array.from({ length: 500 }, (_, index) => index + 1);

describe('PayoutPlanner properties', () => {
  it.each(SEEDS)('seed %i: E, N and T add up and stay in range', (seed) => {
    const c = generate(seed);
    const r = plan(c);
    expect(r.eligible).toBeGreaterThanOrEqual(0n);
    expect(r.netted).toBe(
      r.eligible < (c.receivable > 0n ? c.receivable : 0n)
        ? r.eligible
        : c.receivable > 0n
          ? c.receivable
          : 0n,
    );
    expect(r.netted + r.transfer).toBe(r.eligible);
    expect(r.transfer).toBeGreaterThanOrEqual(0n);
    expect(r.netted).toBeGreaterThanOrEqual(0n);
    expect(r.belowMinimum).toBe(r.transfer > 0n && r.transfer < c.minimumMinor);
  });

  it.each(SEEDS)('seed %i: E is exactly the sum of the due, unheld, positive items', (seed) => {
    const c = generate(seed);
    const r = plan(c);
    const sellerHeld = c.holds.some((h) => h.sellerOrderId === null);
    const held = new Set(c.holds.map((h) => h.sellerOrderId));
    const expected = c.items.filter(
      (item) =>
        !sellerHeld &&
        item.amount > 0n &&
        item.eligibleAt !== null &&
        Temporal.Instant.compare(item.eligibleAt, NOW) <= 0 &&
        (item.sellerOrderId === null || !held.has(item.sellerOrderId)),
    );
    expect(r.eligibleItemIds).toEqual(expected.map((item) => item.id));
    expect(r.eligible).toBe(expected.reduce((sum, item) => sum + item.amount, 0n));
    expect(r.sellerHeld).toBe(sellerHeld);
  });

  it.each(SEEDS)(
    'seed %i: a hold or a later "now" never adds money the other case lacks',
    (seed) => {
      const c = generate(seed);
      const base = plan(c);
      // Holds only remove: no holds is at least as much as the same case with them.
      expect(plan({ ...c, holds: [] }).eligible).toBeGreaterThanOrEqual(base.eligible);
      // Time only adds: later "now" is at least as much (holds as given).
      expect(plan(c, NOW.add({ hours: 24 })).eligible).toBeGreaterThanOrEqual(base.eligible);
      // A bigger receivable never raises the transfer; it never lowers the eligible amount.
      const more = plan({ ...c, receivable: c.receivable + 1_000n });
      expect(more.transfer).toBeLessThanOrEqual(base.transfer);
      expect(more.eligible).toBe(base.eligible);
    },
  );

  it.each(SEEDS)('seed %i: a hold on the whole seller blocks everything', (seed) => {
    const c = generate(seed);
    const r = plan({ ...c, holds: [...c.holds, { sellerOrderId: null }] });
    expect(r).toMatchObject({
      eligible: 0n,
      netted: 0n,
      transfer: 0n,
      belowMinimum: false,
      eligibleItemIds: [],
      sellerHeld: true,
    });
  });

  it.each(SEEDS.slice(0, 100))(
    'seed %i: the result does not depend on the order of items or holds',
    (seed) => {
      const c = generate(seed);
      const reversed = { ...c, items: [...c.items].reverse(), holds: [...c.holds].reverse() };
      const a = plan(c);
      const b = plan(reversed);
      expect([b.eligible, b.netted, b.transfer, b.belowMinimum]).toEqual([
        a.eligible,
        a.netted,
        a.transfer,
        a.belowMinimum,
      ]);
      expect([...b.eligibleItemIds].sort()).toEqual([...a.eligibleItemIds].sort());
    },
  );
});

describe('PayoutPlanner examples', () => {
  const item = (id: string, amount: bigint, eligibleAt: Temporal.Instant | null, order = 'so-1') =>
    ({ id, sellerOrderId: order, amount, eligibleAt }) satisfies PlannerItem;

  it('counts an item due exactly now, not one a nanosecond later', () => {
    const r = planPayout({
      items: [item('due', 5000n, NOW), item('later', 7000n, NOW.add({ nanoseconds: 1 }))],
      holds: [],
      receivable: 0n,
      minimumMinor: 5000n,
      now: NOW,
    });
    expect(r).toMatchObject({ eligible: 5000n, transfer: 5000n, belowMinimum: false });
  });

  it('nets the receivable first: E 8000, R 3000 gives N 3000 and T 5000', () => {
    const r = planPayout({
      items: [item('a', 8000n, hours(-1))],
      holds: [],
      receivable: 3000n,
      minimumMinor: 5000n,
      now: NOW,
    });
    expect(r).toMatchObject({
      eligible: 8000n,
      netted: 3000n,
      transfer: 5000n,
      belowMinimum: false,
    });
  });

  it('settles by netting when the receivable covers everything (T 0 is not below minimum)', () => {
    const r = planPayout({
      items: [item('a', 8000n, hours(-1))],
      holds: [],
      receivable: 9000n,
      minimumMinor: 5000n,
      now: NOW,
    });
    expect(r).toMatchObject({ eligible: 8000n, netted: 8000n, transfer: 0n, belowMinimum: false });
  });

  it('flags a transfer under the minimum, and treats a negative receivable as zero', () => {
    const r = planPayout({
      items: [item('a', 4999n, hours(-1))],
      holds: [],
      receivable: -100n,
      minimumMinor: 5000n,
      now: NOW,
    });
    expect(r).toMatchObject({ eligible: 4999n, netted: 0n, transfer: 4999n, belowMinimum: true });
  });

  it('holds back only the held seller order, keeps the rest, and skips unanchored items', () => {
    const r = planPayout({
      items: [
        item('held', 6000n, hours(-1), 'so-1'),
        item('free', 2000n, hours(-1), 'so-2'),
        item('unanchored', 9000n, null, 'so-3'),
      ],
      holds: [{ sellerOrderId: 'so-1' }],
      receivable: 0n,
      minimumMinor: 1000n,
      now: NOW,
    });
    expect(r.eligibleItemIds).toEqual(['free']);
    expect(r).toMatchObject({ eligible: 2000n, sellerHeld: false });
  });
});
