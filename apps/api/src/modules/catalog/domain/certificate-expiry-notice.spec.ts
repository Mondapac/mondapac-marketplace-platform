import { Temporal } from '@mondapac/shared-kernel';
import {
  MAX_NOTICE_ATTEMPTS,
  certificateExpiryNoticeMail,
  isUsableNoticeZone,
  lastValidDay,
  noticeRetryAt,
  shouldNoticeOwner,
} from './certificate-expiry-notice';

// The warning to the owners of Offers whose tag rests on an expiring manufacturer certificate
// (certification request C-6; CERT-45; certification slice 15), on both Market fixtures' zones.

const MARKETS = [
  { code: 'AU', zone: 'Australia/Brisbane', boundary: '2027-06-30T14:00:00Z' },
  { code: 'ZZ', zone: 'Asia/Tokyo', boundary: '2027-06-30T15:00:00Z' },
] as const;

describe.each(MARKETS)('certificate expiry notice in market $code', ({ zone, boundary }) => {
  const validUntil = Temporal.Instant.from(boundary);

  it('names the last valid day in the Market zone (the day before the boundary)', () => {
    expect(lastValidDay(validUntil, zone).toString()).toBe('2027-06-30');
    expect(lastValidDay(validUntil.add({ seconds: 1 }), zone).toString()).toBe('2027-07-01');
  });

  it('notices an owner only before the boundary', () => {
    expect(shouldNoticeOwner(validUntil, validUntil.subtract({ seconds: 1 }))).toBe(true);
    expect(shouldNoticeOwner(validUntil, validUntil)).toBe(false);
    expect(shouldNoticeOwner(null, validUntil)).toBe(false);
  });

  it('writes plain text: the type, the count, the day and the zone; no id, number or issuer', () => {
    const mail = certificateExpiryNoticeMail({
      typeCode: 'halal‮',
      offers: 3,
      lastDay: Temporal.PlainDate.from('2027-06-30'),
      zone,
    });
    expect(mail.subject).toBe('A certificate behind your halal badges expires on 2027-06-30');
    expect(mail.text).toContain('3 of your offers show the halal badge');
    expect(mail.text).toContain(`the end of 2027-06-30 (${zone} time)`);
    expect(mail.text).not.toMatch(/[‪-‮]/u);
    const one = certificateExpiryNoticeMail({
      typeCode: 'halal',
      offers: 1,
      lastDay: Temporal.PlainDate.from('2027-06-30'),
      zone,
    });
    expect(one.text).toContain('1 of your offers shows the halal badge');
  });
});

describe('notice zone and retry', () => {
  it.each(['Australia/Brisbane', 'Asia/Tokyo', 'UTC'])('accepts the IANA zone %s', (zone) => {
    expect(isUsableNoticeZone(zone)).toBe(true);
  });

  it.each(['', '+10:00', '2026-01-01T00:00:00+10:00[Australia/Brisbane]', 'Mars/Base', null, 7])(
    'refuses %p as a notice zone',
    (zone) => {
      expect(isUsableNoticeZone(zone)).toBe(false);
    },
  );

  it('retries a failed send later, doubling, then gives up', () => {
    const now = Temporal.Instant.from('2027-06-01T00:00:00Z');
    expect(noticeRetryAt(0, now)?.toString()).toBe('2027-06-01T00:05:00Z');
    expect(noticeRetryAt(1, now)?.toString()).toBe('2027-06-01T00:10:00Z');
    expect(noticeRetryAt(3, now)?.toString()).toBe('2027-06-01T00:40:00Z');
    expect(noticeRetryAt(MAX_NOTICE_ATTEMPTS - 1, now)).toBeNull();
  });
});
