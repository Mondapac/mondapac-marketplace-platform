import type { ApiFailure } from '../api/client.ts';
import type { CertificateSummary } from '../certificates/types.ts';

// The pure half of the "Badges" card of the offer page (certificate badges on an offer).

/** A badge the seller may ask for: a type with a certificate in force. */
export interface BadgeChoice {
  readonly typeCode: string;
  readonly name: string;
}

/** Statuses that mean a certificate is approved (and so may carry a badge); the API decides anyway. */
const IN_FORCE: ReadonlySet<string> = new Set([
  'approved',
  'approved-expiring',
  'approved-renewal-pending',
  'approved-renewal-changes-needed',
]);

/**
 * The types the seller holds an approved certificate for and the offer does not carry yet, each
 * once. `names` maps a type code to its name in the panel's language.
 */
export function badgeChoicesOf(
  certificates: readonly CertificateSummary[],
  carried: readonly string[],
  names: ReadonlyMap<string, string>,
): readonly BadgeChoice[] {
  const seen = new Set(carried);
  const choices: BadgeChoice[] = [];
  for (const certificate of certificates) {
    if (!IN_FORCE.has(certificate.status) || seen.has(certificate.typeCode)) continue;
    seen.add(certificate.typeCode);
    choices.push({
      typeCode: certificate.typeCode,
      name: names.get(certificate.typeCode) ?? certificate.typeCode,
    });
  }
  return choices;
}

const BY_CODE: Readonly<Record<string, string>> = {
  'claim.tag-not-allowed': 'not-allowed',
  'claim.check-unavailable': 'unavailable',
  'tag.exists': 'exists',
  'tag.product-not-published': 'product-not-published',
  'tag.type-unknown': 'type-unknown',
  'tag.suspended': 'suspended',
  'tag.not-found': 'not-found',
  'tag.not-removable': 'not-removable',
  'tag.not-suspended': 'not-suspended',
  'offer.change-pending': 'change-pending',
  'offer.handling-missing': 'handling-missing',
  'offer.not-found': 'not-found',
  'conflict.stale': 'stale',
  'conflict.retry': 'stale',
  'seller.not-eligible': 'not-eligible',
  'request.throttled': 'throttled',
  'access.denied': 'denied',
  'request.csrf': 'csrf',
};

/** The message key (under `catalog.badges.error`) of a refused add, remove or sell-without. */
export function badgeErrorOf(failure: ApiFailure): string {
  const named = BY_CODE[failure.code];
  if (named !== undefined) return `catalog.badges.error.${named}`;
  if (failure.status === 503 || failure.status === 0) return 'catalog.badges.error.unavailable';
  return 'catalog.badges.error.unknown';
}
