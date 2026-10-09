import { err, ok } from '@mondapac/shared-kernel';
import type { MarketContext, Result } from '@mondapac/shared-kernel';
import { MAX_DESCRIPTION_CHARS, MAX_DESCRIPTION_LOCALES } from '../domain/offer';
import type { CatalogMarketPolicy } from './ports/catalog-market-policy';

/** The content fields of an Offer as a seller sends them (create and edit; catalog design 4.4). */
export interface OfferContentInput {
  readonly sellerSku?: unknown;
  readonly conditionCode?: unknown;
  readonly description?: unknown;
}

export interface OfferContent {
  readonly sellerSku: string;
  readonly conditionCode: string;
  readonly description: Record<string, string>;
}

export type OfferContentFailure =
  | { readonly code: 'access.unavailable' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

/**
 * Checks the content fields against the Market: types, the condition list, the supported locales
 * and the size bounds, so oversize text never reaches the claim-text service. Reading the Market's
 * lists is the only thing that can fault (`access.unavailable`, fail closed).
 */
export function parseOfferContent(
  policy: CatalogMarketPolicy,
  market: MarketContext,
  input: OfferContentInput,
): Result<OfferContent, OfferContentFailure> {
  const fail = (path: string, code: string) =>
    err({ code: 'validation.failed', fields: [{ path, code }] } as const);
  if (typeof input.sellerSku !== 'string') return fail('sellerSku', 'type');
  if (typeof input.conditionCode !== 'string') return fail('conditionCode', 'type');
  let conditions: readonly string[];
  let locales: { readonly supported: readonly string[] };
  try {
    conditions = policy.conditions(market);
    locales = policy.locales(market);
  } catch {
    return err({ code: 'access.unavailable' });
  }
  if (!conditions.includes(input.conditionCode)) return fail('conditionCode', 'unknown');
  const description = input.description;
  if (typeof description !== 'object' || description === null || Array.isArray(description)) {
    return fail('description', 'type');
  }
  const entries = Object.entries(description);
  if (entries.length > MAX_DESCRIPTION_LOCALES) return fail('description', 'format');
  for (const [locale, text] of entries) {
    if (!locales.supported.includes(locale)) return fail('description', 'locale');
    if (typeof text !== 'string') return fail('description', 'type');
    if (text.length > MAX_DESCRIPTION_CHARS) return fail('description', 'format');
  }
  return ok({
    sellerSku: input.sellerSku,
    conditionCode: input.conditionCode,
    description: { ...(description as Record<string, string>) },
  });
}
