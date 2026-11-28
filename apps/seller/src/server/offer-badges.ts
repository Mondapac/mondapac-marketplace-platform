import 'server-only';
import {
  CERTIFICATE_VIEW_PERMISSION,
  typeName,
  type CertificateList,
  type CertificateOptions,
} from '../certificates/types.ts';
import { badgeChoicesOf, type BadgeChoice } from '../catalog/offer-badges-logic.ts';
import { serverGet } from './server-fetch.ts';

export interface OfferBadgeData {
  readonly choices: readonly BadgeChoice[];
  readonly names: Readonly<Record<string, string>>;
  /** True when the certificates could not be read (timeout or error): the card must not claim there is none. */
  readonly unavailable: boolean;
}

const NONE: OfferBadgeData = { choices: [], names: {}, unavailable: false };

/**
 * What the "Badges" card of an offer page needs beyond the offer: the types the seller holds an
 * approved certificate for (and the offer does not carry), and the types' names. Any failure, or
 * a session that may not view certificates, gives no choices: the card then shows what the offer
 * carries and the page still works.
 */
export async function loadOfferBadgeData(
  keys: readonly string[],
  carried: readonly string[],
  locale: string,
): Promise<OfferBadgeData> {
  if (!keys.includes(CERTIFICATE_VIEW_PERMISSION)) return NONE;
  const [list, options] = await Promise.all([
    serverGet<CertificateList>('certification/seller/certificates?limit=50', { timeoutMs: 2000 }),
    serverGet<CertificateOptions>('certification/seller/certificate-options', {
      timeoutMs: 2000,
    }),
  ]);
  const names0 =
    options.kind === 'ok'
      ? Object.fromEntries(
          options.body.types.map((type) => [type.code, typeName(type.names, type.code, locale)]),
        )
      : {};
  if (list.kind !== 'ok' || options.kind !== 'ok') {
    return { choices: [], names: names0, unavailable: true };
  }
  const names = new Map(
    options.body.types.map((type) => [type.code, typeName(type.names, type.code, locale)]),
  );
  return {
    choices: badgeChoicesOf(list.body.certificates, carried, names),
    names: Object.fromEntries(names),
    unavailable: false,
  };
}
