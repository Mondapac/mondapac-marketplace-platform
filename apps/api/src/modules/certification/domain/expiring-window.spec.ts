import { Temporal } from '@mondapac/shared-kernel';
import { EXPIRING_WITHIN_MARKET_DAYS, expiringWindowEnd } from './expiring-window';

describe('expiringWindowEnd (dashboards v2, certificates expiring in 30 Market days)', () => {
  it('ends at the start of the Market day after the 30th Market day, in the Market zone', () => {
    // 23:30 on 24 Nov in Brisbane (UTC+10) is still 24 Nov there, while UTC is already 25 Nov
    // only after 14:00 UTC; 13:30 UTC is 23:30 local.
    const now = Temporal.Instant.from('2026-11-24T13:30:00Z');
    expect(expiringWindowEnd(now, 'Australia/Brisbane').toString()).toBe('2026-12-24T14:00:00Z');
  });

  it('follows the zone of a second Market (Auckland, UTC+13 in summer)', () => {
    const now = Temporal.Instant.from('2026-11-24T13:30:00Z'); // 25 Nov 02:30 in Auckland
    expect(expiringWindowEnd(now, 'Pacific/Auckland').toString()).toBe('2026-12-25T11:00:00Z');
  });

  it('uses 30 days by default and refuses a window under one day', () => {
    expect(EXPIRING_WITHIN_MARKET_DAYS).toBe(30);
    const now = Temporal.Instant.from('2026-11-24T00:00:00Z');
    expect(expiringWindowEnd(now, 'UTC', 1).toString()).toBe('2026-11-26T00:00:00Z');
    expect(() => expiringWindowEnd(now, 'UTC', 0)).toThrow(RangeError);
  });
});
