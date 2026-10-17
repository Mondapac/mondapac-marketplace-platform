import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  MAX_FACADE_BATCH,
  sellUnitKey,
  type OfferListingsMap,
  type SellUnitKey,
} from '../../contracts/catalog.facade';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { ListingTags, OfferListingsReader } from '../ports/offer-listings.reader';
import type { OfferSellUnitsFailure } from './offer-sell-units-request';

export interface OfferListingsInput {
  readonly keys: readonly { readonly offerId: string; readonly variantId: string }[];
  readonly locale: string;
}

export interface OfferListingsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly listingsReader: OfferListingsReader;
  readonly policy: CatalogMarketPolicy;
  readonly clock: Clock;
}

/** A BCP 47 tag's shape, as the locales of Market configuration are written. */
const LOCALE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;

/**
 * The read of `offerListings` (catalog design 9.1) for both rules: the request is checked whole
 * before any read (at most 200 keys, refused whole above, Hassan L7; ids and locale well formed),
 * duplicates collapse, and one read-only unit answers (ADR-0025). `tags` is decided by the use
 * case's rule, never by input: `none` for `anonymous` (no tag at all), `live` for `system`.
 */
export async function readOfferListings(
  deps: OfferListingsDependencies,
  context: CallContext,
  input: OfferListingsInput,
  tags: ListingTags,
): Promise<Result<OfferListingsMap, OfferSellUnitsFailure>> {
  if (typeof input !== 'object' || input === null || !Array.isArray(input.keys)) {
    return err({ code: 'validation.failed', fields: [{ path: 'keys', code: 'type' }] });
  }
  if (input.keys.length > MAX_FACADE_BATCH) return err({ code: 'batch.too-large' });
  if (typeof input.locale !== 'string' || !LOCALE.test(input.locale)) {
    return err({ code: 'validation.failed', fields: [{ path: 'locale', code: 'format' }] });
  }
  const distinct = new Map<string, SellUnitKey>();
  for (const raw of input.keys as readonly unknown[]) {
    const item = raw as { offerId?: unknown; variantId?: unknown } | null;
    const offer = typeof item?.offerId === 'string' ? parseId<'Offer'>(item.offerId) : null;
    const variant = typeof item?.variantId === 'string' ? parseId<'Variant'>(item.variantId) : null;
    if (offer === null || !offer.ok || variant === null || !variant.ok) {
      return err({ code: 'validation.failed', fields: [{ path: 'keys', code: 'format' }] });
    }
    const key = { offerId: offer.value, variantId: variant.value };
    distinct.set(sellUnitKey(key), key);
  }
  if (distinct.size === 0) return ok(new Map());
  // A Market without catalog configuration fails boot (market-config check), so this answers.
  const fallback = deps.policy.locales(context.market).default;
  const requested = [...distinct.values()];
  return deps.unitOfWork.run<OfferListingsMap, OfferSellUnitsFailure>(
    context.market,
    async () =>
      ok(
        await deps.listingsReader.read(
          context.market,
          requested,
          { requested: input.locale, fallback },
          tags,
          deps.clock.now(),
        ),
      ),
    { readOnly: true },
  );
}
