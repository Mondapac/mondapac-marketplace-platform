import { Temporal } from '@mondapac/shared-kernel';
import { approvalBoundary, daysLeftAt } from '../../domain/expiry';
import { bannerToneOf } from './own-certificate-view';

// The seller's expiry display (seller certificate pages, design 5.1): days left and the banner
// tone from the Market's thresholds. Display only; the claim is `evaluateClaims`'.

describe('days left', () => {
  // Expiry date 30 Jun 2027: the boundary is 00:00 of 1 Jul in the approval zone.
  it.each([
    ['Australia/Brisbane', '2027-06-30T14:00:00Z', '2027-06-29T13:59:59Z', 1],
    ['Australia/Brisbane', '2027-06-30T14:00:00Z', '2027-06-29T14:00:00Z', 0],
    ['Australia/Brisbane', '2027-06-30T14:00:00Z', '2027-06-30T14:00:00Z', -1],
    ['Pacific/Auckland', '2027-06-30T12:00:00Z', '2027-06-29T11:59:59Z', 1],
    ['Pacific/Auckland', '2027-06-30T12:00:00Z', '2027-06-29T12:00:00Z', 0],
  ])('counts local days in the approval zone %s', (zone, boundary, at, days) => {
    expect(
      daysLeftAt(
        approvalBoundary(Temporal.Instant.from(boundary), zone),
        Temporal.Instant.from(at),
      ),
    ).toBe(days);
  });

  it('counts whole 24-hour days back from the stored boundary without a usable zone', () => {
    const boundary = approvalBoundary(Temporal.Instant.from('2027-06-30T14:00:00Z'), '+10:00');
    expect(boundary.zone).toBeNull();
    const at = (iso: string) => daysLeftAt(boundary, Temporal.Instant.from(iso));
    expect(at('2027-06-29T14:00:00Z')).toBe(0);
    expect(at('2027-06-29T13:59:59Z')).toBe(1);
    expect(at('2027-06-30T14:00:00Z')).toBe(-1);
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

  it('follows the Market thresholds, in any order: critical is only the last day', () => {
    expect(bannerToneOf('approved-expiring', 10, [7, 60, 3])).toBe('info');
    expect(bannerToneOf('approved-expiring', 6, [7, 60, 3])).toBe('attention');
    expect(bannerToneOf('approved-expiring', 2, [7, 60, 3])).toBe('attention');
    expect(bannerToneOf('approved-expiring', 0, [7, 60, 3])).toBe('critical');
    expect(bannerToneOf('approved-expiring', 6, [30, 7])).toBe('attention');
    expect(bannerToneOf('approved-expiring', 3, [30])).toBe('info');
    expect(bannerToneOf('approved-expiring', 3, [])).toBe('info');
  });
});
