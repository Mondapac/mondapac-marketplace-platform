import { Temporal } from '@mondapac/shared-kernel';
import { assessBacklog, businessHoursBetween } from './offer-queue-backlog';

const at = (text: string) => Temporal.Instant.from(text);
const SYDNEY = 'Australia/Sydney';
const LIMITS = { count: 50, hours: 24 };

describe('businessHoursBetween', () => {
  it('counts every hour of a weekday span', () => {
    // Tuesday 2026-11-24 00:00 to Wednesday 12:00, Sydney time (UTC+11).
    expect(
      businessHoursBetween(at('2026-11-23T13:00:00Z'), at('2026-11-25T01:00:00Z'), SYDNEY),
    ).toBe(36);
  });

  it('leaves out Saturday and Sunday in the Market zone', () => {
    // Friday 2026-11-27 18:00 to Monday 2026-11-30 06:00, Sydney time: 6 h Friday + 6 h Monday.
    expect(
      businessHoursBetween(at('2026-11-27T07:00:00Z'), at('2026-11-29T19:00:00Z'), SYDNEY),
    ).toBe(12);
  });

  it('is zero inside a weekend, and for a span that does not run forward', () => {
    expect(
      businessHoursBetween(at('2026-11-28T00:00:00Z'), at('2026-11-28T20:00:00Z'), SYDNEY),
    ).toBe(0);
    expect(
      businessHoursBetween(at('2026-11-25T01:00:00Z'), at('2026-11-24T01:00:00Z'), SYDNEY),
    ).toBe(0);
  });

  it('decides the weekday by the zone, not by UTC', () => {
    // 2026-11-29 (Sunday) 20:00 UTC is Monday 07:00 in Sydney: 2 h of Monday up to 09:00 Sydney.
    expect(
      businessHoursBetween(at('2026-11-29T20:00:00Z'), at('2026-11-29T22:00:00Z'), SYDNEY),
    ).toBe(2);
    // The same two hours in a zone where it is still Sunday count nothing.
    expect(
      businessHoursBetween(
        at('2026-11-29T20:00:00Z'),
        at('2026-11-29T22:00:00Z'),
        'America/Los_Angeles',
      ),
    ).toBe(0);
  });

  it('counts a daylight-saving day by its real length', () => {
    // Sydney's clocks go forward on Sunday 2026-10-04; Monday 5 Oct is a normal 24 h day.
    expect(
      businessHoursBetween(at('2026-10-04T13:00:00Z'), at('2026-10-05T13:00:00Z'), SYDNEY),
    ).toBe(24);
    // Los Angeles clocks go back on Sunday 2026-11-01; Friday 2026-10-30 to Monday 2026-11-02 00:00.
    expect(
      businessHoursBetween(
        at('2026-10-30T07:00:00Z'),
        at('2026-11-02T08:00:00Z'),
        'America/Los_Angeles',
      ),
    ).toBe(24);
  });
});

describe('assessBacklog', () => {
  const now = at('2026-11-25T01:00:00Z');

  it('raises nothing for an empty queue, and for one at exactly a limit', () => {
    expect(assessBacklog({ count: 0, oldestAt: null }, LIMITS, now, SYDNEY)).toEqual({
      reason: null,
      waitedHours: 0,
    });
    // Exactly 50 Offers and the oldest exactly 24 business hours: not more than either limit.
    expect(
      assessBacklog({ count: 50, oldestAt: at('2026-11-24T01:00:00Z') }, LIMITS, now, SYDNEY),
    ).toEqual({ reason: null, waitedHours: 24 });
  });

  it('names the age, the size, or both', () => {
    const old = at('2026-11-23T01:00:00Z');
    expect(assessBacklog({ count: 3, oldestAt: old }, LIMITS, now, SYDNEY)).toEqual({
      reason: 'age',
      waitedHours: 48,
    });
    expect(
      assessBacklog({ count: 51, oldestAt: at('2026-11-25T00:00:00Z') }, LIMITS, now, SYDNEY),
    ).toEqual({ reason: 'size', waitedHours: 1 });
    expect(assessBacklog({ count: 51, oldestAt: old }, LIMITS, now, SYDNEY).reason).toBe('both');
  });

  it('does not count a weekend as waiting time', () => {
    // Submitted Friday 2026-11-27 17:00 Sydney, checked Monday 2026-11-30 09:00: 7 h + 9 h = 16 h.
    expect(
      assessBacklog(
        { count: 4, oldestAt: at('2026-11-27T06:00:00Z') },
        LIMITS,
        at('2026-11-29T22:00:00Z'),
        SYDNEY,
      ),
    ).toEqual({ reason: null, waitedHours: 16 });
  });
});
