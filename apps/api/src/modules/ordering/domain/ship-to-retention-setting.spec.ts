import { Temporal } from '@mondapac/shared-kernel';
import {
  DEFAULT_SHIP_TO_RETENTION,
  isShipToPurgeable,
  parseShipToRetentionInput,
  sellerOrderSettledAt,
  shipToRetentionCutoff,
} from './ship-to-retention';
import {
  settlementCases,
  settlementFacts,
} from '../../../../test/support/ship-to-settlement-fixtures';

// The admin setting that clears the sealed ship-to of settled orders (owner decisions 2026-11-15):
// off by default (the deletion is irreversible), 24 months by default, 1 to 120. Settled: every
// seller order delivered, shipped and never delivered, cancelled with the order, or refunded in
// full while to ship, the latest at or before the cutoff.

describe.each([
  ['AU', 'Australia/Brisbane'],
  ['ZZ', 'Asia/Tokyo'],
] as const)('the ship-to retention rule in market %s', (_code, zone) => {
  const local = (text: string) =>
    Temporal.PlainDateTime.from(text).toZonedDateTime(zone).toInstant();
  const now = local('2026-11-15T03:00:00');

  it('is off by default, 24 months, version 0 (no row)', () => {
    expect(DEFAULT_SHIP_TO_RETENTION).toEqual({ enabled: false, months: 24 });
  });

  it("counts the months back in the Market's zone", () => {
    expect(shipToRetentionCutoff(now, zone, 24).equals(local('2024-11-15T03:00:00'))).toBe(true);
    expect(shipToRetentionCutoff(now, zone, 1).equals(local('2026-10-15T03:00:00'))).toBe(true);
  });

  it('clamps a month end: 31 March less one month is the last day of February', () => {
    const cutoff = shipToRetentionCutoff(local('2028-03-31T12:00:00'), zone, 1);
    expect(cutoff.equals(local('2028-02-29T12:00:00'))).toBe(true);
  });

  const cutoff = shipToRetentionCutoff(now, zone, 24);

  it.each(settlementCases(cutoff).map((c) => [c.name, c.spec, c.purgeable] as const))(
    'settles: %s',
    (_name, spec, purgeable) => {
      expect(isShipToPurgeable(settlementFacts(spec), cutoff)).toBe(purgeable);
    },
  );

  it('clears an order delivered 24 months ago in the zone, not one delivered 23 months 29 days ago', () => {
    const delivered = (at: string) =>
      settlementFacts({ sellerOrders: [{ kind: 'delivered', at: local(at) }] });
    expect(isShipToPurgeable(delivered('2024-11-15T03:00:00'), cutoff)).toBe(true);
    expect(isShipToPurgeable(delivered('2024-11-16T03:00:00'), cutoff)).toBe(false);
  });

  it('never settles a pending-payment order or an order without seller orders', () => {
    expect(
      isShipToPurgeable(
        settlementFacts({ status: 'pending-payment', sellerOrders: [{ kind: 'to-ship' }] }),
        cutoff,
      ),
    ).toBe(false);
    expect(isShipToPurgeable(settlementFacts({ sellerOrders: [] }), cutoff)).toBe(false);
    // A cancelled order whose instant is missing (the CHECK rules it out) deletes nothing.
    expect(
      isShipToPurgeable(
        settlementFacts({ status: 'cancelled', sellerOrders: [{ kind: 'to-ship' }] }),
        cutoff,
      ),
    ).toBe(false);
  });

  it('dates a refund in full by when the completing succeeded refund settled, ignoring pending ones', () => {
    const at = (text: string) => local(text);
    const facts = settlementFacts({
      sellerOrders: [
        {
          kind: 'to-ship',
          refunds: [
            { at: at('2023-01-01T00:00:00'), units: 1 },
            { at: at('2023-01-02T00:00:00'), units: 1, state: 'pending' },
            { at: at('2023-01-03T00:00:00'), units: 1, state: 'failed' },
            { at: at('2023-01-04T00:00:00'), units: 1 },
          ],
        },
      ],
    });
    expect(
      sellerOrderSettledAt(facts, facts.sellerOrders[0]!)?.equals(at('2023-01-04T00:00:00')),
    ).toBe(true);
  });

  it('dates a refund in full by the refund that completed it, not a later one', () => {
    const old = local('2023-01-01T00:00:00');
    const facts = settlementFacts({
      sellerOrders: [{ kind: 'to-ship', refunds: [{ at: old, units: 2 }] }],
    });
    // A later refund not failed (for example of the shipping fee only) gives back no line unit.
    const withLater = {
      ...facts,
      sellerOrders: facts.sellerOrders.map((so) => ({
        ...so,
        refunds: [...so.refunds, { state: 'succeeded' as const, settledAt: now, lines: [] }],
      })),
    };
    expect(sellerOrderSettledAt(withLater, withLater.sellerOrders[0]!)?.equals(old)).toBe(true);
    expect(isShipToPurgeable(withLater, cutoff)).toBe(true);
  });

  it.each([
    [{ enabled: true, months: 0, expectedVersion: 0 }, 'months'],
    [{ enabled: true, months: 121, expectedVersion: 0 }, 'months'],
    [{ enabled: true, months: 2.5, expectedVersion: 0 }, 'months'],
    [{ enabled: true, months: '24', expectedVersion: 0 }, 'months'],
    [{ enabled: 'yes', months: 24, expectedVersion: 0 }, 'enabled'],
    [{ enabled: true, months: 24, expectedVersion: -1 }, 'expectedVersion'],
    [{ enabled: true, months: 24, expectedVersion: 1.5 }, 'expectedVersion'],
  ])('refuses %j at %s', (input, path) => {
    const parsed = parseShipToRetentionInput(input);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.fields.map((field) => field.path)).toEqual([path]);
  });

  it('reads 1 and 120 months', () => {
    expect(parseShipToRetentionInput({ enabled: true, months: 1, expectedVersion: 0 })).toEqual({
      ok: true,
      value: { enabled: true, months: 1, expectedVersion: 0 },
    });
    expect(parseShipToRetentionInput({ enabled: false, months: 120, expectedVersion: 3 })).toEqual({
      ok: true,
      value: { enabled: false, months: 120, expectedVersion: 3 },
    });
  });
});
