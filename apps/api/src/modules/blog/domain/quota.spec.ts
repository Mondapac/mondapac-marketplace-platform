import { Temporal } from '@mondapac/shared-kernel';
import { hasQuotaLeft, quotaPeriod, quotaView } from './quota';

describe('seller quota', () => {
  it('reads the month in the Market zone, not in UTC', () => {
    // 2026-10-31 15:30 UTC is already 1 November in Brisbane (UTC+10) and Tokyo (UTC+9).
    const instant = Temporal.Instant.from('2026-10-31T15:30:00Z');
    expect(quotaPeriod(instant, 'UTC')).toBe('2026-10');
    expect(quotaPeriod(instant, 'Australia/Brisbane')).toBe('2026-11');
    expect(quotaPeriod(instant, 'Asia/Tokyo')).toBe('2026-11');
    expect(quotaPeriod(instant, 'America/Los_Angeles')).toBe('2026-10');
  });

  it('rolls the year over', () => {
    expect(quotaPeriod(Temporal.Instant.from('2026-12-31T14:00:00Z'), 'Australia/Brisbane')).toBe(
      '2027-01',
    );
  });

  it('allows a post only while the month is not used up', () => {
    expect(hasQuotaLeft(3, 4)).toBe(true);
    expect(hasQuotaLeft(4, 4)).toBe(false);
    expect(hasQuotaLeft(0, 0)).toBe(false);
    expect(quotaView('2026-10', 4, 5)).toEqual({
      period: '2026-10',
      limit: 4,
      used: 5,
      remaining: 0,
    });
  });
});
