import { Temporal } from '@mondapac/shared-kernel';
import { bannerToneOf, daysLeftOf } from './own-certificate-view';

// The seller's expiry display (seller certificate pages, design 5.1): days left and the banner
// tone from the Market's thresholds. Display only; the claim is `evaluateClaims`'.

describe('days left', () => {
  const expiry = Temporal.PlainDate.from('2027-06-30');

  it.each([
    ['Australia/Brisbane', '2027-06-29T13:59:59Z', 1],
    ['Australia/Brisbane', '2027-06-29T14:00:00Z', 0],
    ['Australia/Brisbane', '2027-06-30T14:00:00Z', -1],
    ['Pacific/Auckland', '2027-06-29T11:59:59Z', 1],
    ['Pacific/Auckland', '2027-06-29T12:00:00Z', 0],
  ])('counts local days in the approval zone %s at %s', (zone, at, days) => {
    expect(daysLeftOf(expiry, zone, null, Temporal.Instant.from(at))).toBe(days);
  });

  it('counts back from the stored boundary when the approval zone is not usable', () => {
    const boundary = Temporal.Instant.from('2027-06-30T14:00:00Z');
    const at = (iso: string) => daysLeftOf(expiry, '+10:00', boundary, Temporal.Instant.from(iso));
    expect(at('2027-06-29T14:00:00Z')).toBe(0);
    expect(at('2027-06-29T13:59:59Z')).toBe(1);
    expect(at('2027-06-30T14:00:00Z')).toBe(-1);
    expect(
      daysLeftOf(expiry, null, null, Temporal.Instant.from('2027-06-29T00:00:00Z')),
    ).toBeNull();
  });
});

describe('banner tone', () => {
  const thresholds = [30, 14, 1];

  it.each([
    [29, 'info'],
    [14, 'info'],
    [13, 'attention'],
    [1, 'attention'],
    [0, 'critical'],
  ] as const)('is %s days left: %s', (days, tone) => {
    expect(bannerToneOf('approved-expiring', days, thresholds)).toBe(tone);
  });

  it('is critical when expired and none for any other status', () => {
    expect(bannerToneOf('expired', -3, thresholds)).toBe('critical');
    for (const status of [
      'approved',
      'approved-renewal-pending',
      'approved-renewal-changes-needed',
      'expired-renewal-pending',
      'draft',
    ] as const) {
      expect(bannerToneOf(status, 5, thresholds)).toBeNull();
    }
  });

  it('follows the Market thresholds, in any order', () => {
    expect(bannerToneOf('approved-expiring', 4, [7, 60, 3])).toBe('attention');
    expect(bannerToneOf('approved-expiring', 2, [7, 60, 3])).toBe('critical');
    expect(bannerToneOf('approved-expiring', 10, [7, 60, 3])).toBe('info');
    expect(bannerToneOf('approved-expiring', 3, [30])).toBe('info');
    expect(bannerToneOf('approved-expiring', 3, [])).toBe('info');
  });
});
