import { Temporal } from '@mondapac/shared-kernel';

// The warning catalog sends to the owner of each Offer whose badge rests on a manufacturer
// certificate that is about to expire (certification design 8.3, 18 request C-6; CERT-45;
// certification slice 15). Plain text only: the mail transport sends no HTML. The type code is
// data and is made one line; no certificate number, issuer, document or id goes into the mail.
// The final words are Reza's with ux-copy; these are working texts, like certification's mails.

export interface CertificateExpiryNoticeMail {
  readonly subject: string;
  readonly text: string;
}

/** One line of plain text: no control or format characters. */
function line(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The last day the certificate counts, in the Market zone: the boundary is 00:00 of the day after
 * the expiry date (certification design 2.4 rule 3), so the day of the instant just before it.
 */
export function lastValidDay(validUntil: Temporal.Instant, zone: string): Temporal.PlainDate {
  return validUntil.subtract({ nanoseconds: 1 }).toZonedDateTimeISO(zone).toPlainDate();
}

/**
 * True for a zone Temporal resolves that is an IANA id (ADR-0005 decision 1): a non-empty string,
 * not a UTC offset. The mail names a day in this zone, so anything else sends no mail (Hassan I2).
 * Catalog's own check, as certification's `isUsableZone` (no import across modules).
 */
export function isUsableNoticeZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || zone.length === 0 || zone.length > 64) return false;
  if (/^[+-]/u.test(zone)) return false;
  try {
    // Temporal's parser also takes ISO date-times and offsets and keeps only the zone part,
    // which must not count as an IANA id: compare what it resolved with the input.
    const resolved =
      Temporal.Instant.from('2026-01-01T00:00:00Z').toZonedDateTimeISO(zone).timeZoneId;
    return !/^[+-]/u.test(resolved) && resolved.toLowerCase() === zone.toLowerCase();
  } catch {
    return false;
  }
}

/** The sends of one notice before it is given up as `failed` (and logged as an error). */
export const MAX_NOTICE_ATTEMPTS = 5;

/**
 * When a notice whose send failed is tried again: 5 minutes after the first failure, doubling
 * each time (5, 10, 20, 40 minutes). `null` once the attempts are used up: the notice fails.
 */
export function noticeRetryAt(
  attemptsSoFar: number,
  now: Temporal.Instant,
): Temporal.Instant | null {
  const attempts = attemptsSoFar + 1;
  if (attempts >= MAX_NOTICE_ATTEMPTS) return null;
  return now.add({ minutes: 5 * 2 ** (attempts - 1) });
}

/** A warning delivered at or after the boundary would say the wrong thing: none is sent. */
export function shouldNoticeOwner(
  validUntil: Temporal.Instant | null,
  now: Temporal.Instant,
): boolean {
  return validUntil !== null && Temporal.Instant.compare(now, validUntil) < 0;
}

export function certificateExpiryNoticeMail(input: {
  readonly typeCode: string;
  /** The seller's Offers whose badge rests on the certificate. */
  readonly offers: number;
  readonly lastDay: Temporal.PlainDate;
  /** The Market zone the day is counted in (IANA id). */
  readonly zone: string;
}): CertificateExpiryNoticeMail {
  const type = line(input.typeCode);
  const day = line(input.lastDay.toString());
  const zone = line(input.zone);
  const offers =
    input.offers === 1 ? '1 of your offers shows' : `${input.offers} of your offers show`;
  return {
    subject: `A certificate behind your ${type} badges expires on ${day}`,
    text: [
      `A certificate behind your ${type} badges expires on ${day}`,
      '',
      `${offers} the ${type} badge on the basis of the manufacturer's certificate for the product. That certificate counts until the end of ${day} (${zone} time).`,
      '',
      `If it is not renewed by then, those offers no longer show the ${type} badge. You can keep selling them without it, or add your own ${type} certificate.`,
      '',
      'Open your seller panel to see the offers concerned.',
      '',
    ].join('\n'),
  };
}
