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
