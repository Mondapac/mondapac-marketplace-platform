import { Temporal } from '@mondapac/shared-kernel';
import {
  contains,
  isWellFormed,
  localDateOf,
  overlaps,
  startOfLocalDate,
  type EffectivePeriod,
} from './effective-period';

const at = (text: string) => Temporal.Instant.from(text);
const period = (from: string, to: string | null): EffectivePeriod => ({
  validFrom: at(from),
  validTo: to === null ? null : at(to),
});

describe('EffectivePeriod (sellers design 2.4 rule 4)', () => {
  const closed = period('2026-01-01T00:00:00Z', '2026-07-01T00:00:00Z');

  it('is half-open: from inclusive, to exclusive', () => {
    expect(contains(closed, at('2026-01-01T00:00:00Z'))).toBe(true);
    expect(contains(closed, at('2026-06-30T23:59:59.999Z'))).toBe(true);
    expect(contains(closed, at('2026-07-01T00:00:00Z'))).toBe(false);
    expect(contains(closed, at('2025-12-31T23:59:59.999Z'))).toBe(false);
  });

  it('is open to the future when validTo is null', () => {
    expect(contains(period('2026-01-01T00:00:00Z', null), at('2999-01-01T00:00:00Z'))).toBe(true);
  });

  it('does not overlap a period that starts where it ends, in either order', () => {
    const next = period('2026-07-01T00:00:00Z', null);
    expect(overlaps(closed, next)).toBe(false);
    expect(overlaps(next, closed)).toBe(false);
  });

  it('overlaps by one millisecond, by containment and with an open period', () => {
    expect(overlaps(closed, period('2026-06-30T23:59:59.999Z', null))).toBe(true);
    expect(overlaps(closed, period('2026-02-01T00:00:00Z', '2026-03-01T00:00:00Z'))).toBe(true);
    expect(
      overlaps(period('2026-01-01T00:00:00Z', null), period('2030-01-01T00:00:00Z', null)),
    ).toBe(true);
  });

  it('is well formed only when it is not empty', () => {
    expect(isWellFormed(closed)).toBe(true);
    expect(isWellFormed(period('2026-01-01T00:00:00Z', null))).toBe(true);
    expect(isWellFormed(period('2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'))).toBe(false);
    expect(isWellFormed(period('2026-02-01T00:00:00Z', '2026-01-01T00:00:00Z'))).toBe(false);
  });

  it('turns a local date into 00:00 in the owning zone, not in the Market or UTC', () => {
    const date = Temporal.PlainDate.from('2026-03-10');
    expect(startOfLocalDate(date, 'Australia/Brisbane')).toEqual(at('2026-03-09T14:00:00Z'));
    expect(startOfLocalDate(date, 'Pacific/Auckland')).toEqual(at('2026-03-09T11:00:00Z'));
    expect(startOfLocalDate(date, 'America/New_York')).toEqual(at('2026-03-10T04:00:00Z'));
  });

  it('reads the local date of an instant in a zone', () => {
    expect(localDateOf(at('2026-03-09T14:00:00Z'), 'Australia/Brisbane').toString()).toBe(
      '2026-03-10',
    );
    expect(localDateOf(at('2026-03-09T14:00:00Z'), 'UTC').toString()).toBe('2026-03-09');
  });
});
