import { Temporal } from '@mondapac/shared-kernel';
import {
  CLAIM_TEXT_CHECK_LIMITS,
  DRAFT_SAVE_LIMITS,
  RATE_COUNTER_KINDS,
  SUBMIT_LIMITS,
  rateVerdict,
  windowRestartBefore,
  type RateReservation,
} from './rate-limits';

const T0 = Temporal.Instant.from('2026-10-08T00:00:00Z');

describe('catalog rate limits', () => {
  it('holds the claim-text check limits of design 8.4: 30 a minute and 1,000 a day', () => {
    expect(CLAIM_TEXT_CHECK_LIMITS).toEqual([
      { kind: 'claim-text-check.account.minute', limit: 30, windowMinutes: 1 },
      { kind: 'claim-text-check.account.day', limit: 1000, windowMinutes: 1440 },
    ]);
  });

  it('names only kinds the table accepts, in the order a unit takes them', () => {
    expect([...RATE_COUNTER_KINDS]).toEqual([...RATE_COUNTER_KINDS].sort());
    for (const limit of [...DRAFT_SAVE_LIMITS, ...SUBMIT_LIMITS, ...CLAIM_TEXT_CHECK_LIMITS]) {
      expect(RATE_COUNTER_KINDS).toContain(limit.kind);
    }
  });

  it('allows an attempt at the limit and refuses the one after it', () => {
    const at = (count: number): RateReservation[] => [
      { kind: 'draft-save.account.minute', count, windowStartedAt: T0 },
      { kind: 'draft-save.account.day', count, windowStartedAt: T0 },
    ];
    expect(rateVerdict(DRAFT_SAVE_LIMITS, at(60), T0)).toEqual({ allowed: true });
    expect(rateVerdict(DRAFT_SAVE_LIMITS, at(61), T0.add({ seconds: 20 }))).toEqual({
      allowed: false,
      retryAfterSeconds: 40,
    });
  });

  it('announces the longest rest of the refusing windows', () => {
    const reserved: RateReservation[] = [
      { kind: 'draft-save.account.minute', count: 61, windowStartedAt: T0 },
      { kind: 'draft-save.account.day', count: 1001, windowStartedAt: T0 },
    ];
    expect(rateVerdict(DRAFT_SAVE_LIMITS, reserved, T0.add({ minutes: 10 }))).toEqual({
      allowed: false,
      retryAfterSeconds: 24 * 3600 - 600,
    });
  });

  it('never passes a limit without its reservation', () => {
    expect(() => rateVerdict(SUBMIT_LIMITS, [], T0)).toThrow(/no reservation/);
  });

  it('restarts a window that started a full window ago', () => {
    expect(windowRestartBefore(DRAFT_SAVE_LIMITS[0]!, T0).toString()).toBe('2026-10-07T23:59:00Z');
  });
});
