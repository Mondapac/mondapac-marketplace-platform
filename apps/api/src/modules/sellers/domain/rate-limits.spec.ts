import { Temporal } from '@mondapac/shared-kernel';
import {
  RATE_COUNTER_KINDS,
  budgetAlertCount,
  lookupAccountLimits,
  lookupMarketLimits,
  lookupOriginLimits,
  SAVE_LIMITS,
  SLUG_CHECK_LIMITS,
  rateVerdict,
  windowRestartBefore,
  type RateReservation,
} from './rate-limits';

const NOW = Temporal.Instant.from('2026-10-08T10:00:30Z');
const STARTED = Temporal.Instant.from('2026-10-08T10:00:00Z');

const reservation = (kind: RateReservation['kind'], count: number): RateReservation => ({
  kind,
  count,
  windowStartedAt: STARTED,
});

describe('sellers rate limits', () => {
  it('lists the 13 kinds of the migration, sorted (the lock order)', () => {
    expect(RATE_COUNTER_KINDS).toHaveLength(13);
    expect([...RATE_COUNTER_KINDS].sort()).toEqual([...RATE_COUNTER_KINDS]);
  });

  it('holds Hassan`s numbers for slug checks and saves (design 6.5)', () => {
    expect(SLUG_CHECK_LIMITS.map(({ limit, windowMinutes }) => [limit, windowMinutes])).toEqual([
      [30, 1],
      [300, 1440],
    ]);
    expect(SAVE_LIMITS.map(({ limit, windowMinutes }) => [limit, windowMinutes])).toEqual([
      [60, 1],
      [1000, 1440],
    ]);
  });

  it('allows up to the limit and refuses above it, with the rest of the window', () => {
    expect(
      rateVerdict(
        SAVE_LIMITS,
        [reservation('save.account.minute', 60), reservation('save.account.day', 60)],
        NOW,
      ),
    ).toEqual({ allowed: true });
    expect(
      rateVerdict(
        SAVE_LIMITS,
        [reservation('save.account.minute', 61), reservation('save.account.day', 61)],
        NOW,
      ),
    ).toEqual({ allowed: false, retryAfterSeconds: 30 });
    expect(
      rateVerdict(
        SLUG_CHECK_LIMITS,
        [reservation('slug-check.account.minute', 5), reservation('slug-check.account.day', 301)],
        NOW,
      ),
    ).toEqual({ allowed: false, retryAfterSeconds: 24 * 3600 - 30 });
  });

  it('never passes a limit whose reservation is missing', () => {
    expect(() => rateVerdict(SAVE_LIMITS, [reservation('save.account.minute', 1)], NOW)).toThrow();
  });

  it('restarts a window that started one window length ago', () => {
    expect(windowRestartBefore(SAVE_LIMITS[0]!, NOW)).toEqual(
      Temporal.Instant.from('2026-10-08T09:59:30Z'),
    );
  });

  describe('the register-lookup quotas (design 6.5, 7.7)', () => {
    it('are built from the configured numbers, one 24 h window each', () => {
      expect(lookupAccountLimits(5)).toEqual([
        { kind: 'lookup.account', limit: 5, windowMinutes: 1440 },
      ]);
      expect(lookupOriginLimits(30)).toEqual([
        { kind: 'lookup.origin', limit: 30, windowMinutes: 1440 },
      ]);
      expect(lookupMarketLimits(1000)).toEqual([
        { kind: 'lookup.market', limit: 1000, windowMinutes: 1440 },
      ]);
      expect(lookupAccountLimits(2)[0]!.limit).toBe(2);
    });

    it('refuse a limit that is not a positive whole number', () => {
      for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => lookupAccountLimits(bad)).toThrow(RangeError);
        expect(() => lookupMarketLimits(bad)).toThrow(RangeError);
      }
    });

    it('refuse the call above the limit, and not at it', () => {
      const limits = lookupAccountLimits(5);
      expect(rateVerdict(limits, [reservation('lookup.account', 5)], NOW)).toEqual({
        allowed: true,
      });
      expect(rateVerdict(limits, [reservation('lookup.account', 6)], NOW)).toEqual({
        allowed: false,
        retryAfterSeconds: 24 * 3600 - 30,
      });
    });

    it('alert at the first call that reaches 80% of the budget', () => {
      expect(budgetAlertCount(1000)).toBe(800);
      expect(budgetAlertCount(10)).toBe(8);
      expect(budgetAlertCount(3)).toBe(3);
    });
  });
});
