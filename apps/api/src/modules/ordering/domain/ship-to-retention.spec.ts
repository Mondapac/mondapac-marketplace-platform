import { Temporal } from '@mondapac/shared-kernel';
import {
  DEFAULT_SHIP_TO_RETENTION,
  isShipToPurgeable,
  parseShipToRetentionInput,
  shipToRetentionCutoff,
} from './ship-to-retention';

// The admin setting that clears the sealed ship-to of delivered orders (owner decision
// 2026-11-15): off by default (the deletion is irreversible), 24 months by default, 1 to 120.

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

  it('clears an order delivered at the cutoff, not one delivered a day later', () => {
    const cutoff = shipToRetentionCutoff(now, zone, 24);
    expect(isShipToPurgeable([{ deliveredAt: local('2024-11-15T03:00:00') }], cutoff)).toBe(true);
    // 23 months and 29 days ago.
    expect(isShipToPurgeable([{ deliveredAt: local('2024-11-16T03:00:00') }], cutoff)).toBe(false);
  });

  it('needs every seller order delivered before the cutoff, and at least one', () => {
    const cutoff = shipToRetentionCutoff(now, zone, 24);
    const old = { deliveredAt: local('2023-01-01T00:00:00') };
    expect(isShipToPurgeable([old, old], cutoff)).toBe(true);
    expect(isShipToPurgeable([old, { deliveredAt: null }], cutoff)).toBe(false);
    expect(isShipToPurgeable([old, { deliveredAt: local('2026-01-01T00:00:00') }], cutoff)).toBe(
      false,
    );
    expect(isShipToPurgeable([], cutoff)).toBe(false);
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
