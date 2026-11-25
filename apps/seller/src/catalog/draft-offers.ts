import { callApi, type ApiResult } from '../api/client.ts';
import { DEFAULTS_SOURCE_PATH, offerDefaultsOf, type OfferDefaults } from './offer-defaults.ts';
import type { OfferView, ProductOptions } from './types.ts';

/** The answer of the keyset read of the seller's offers (only the rows are used here). */
interface OfferPage {
  readonly items: readonly Pick<OfferView, 'conditionCode' | 'handling'>[];
}

/**
 * Reads what a new draft starts with: the Market's conditions and the seller's newest offers.
 * When the offers cannot be read the Market default and Sealed original are used; when the
 * conditions cannot be read no draft can be made (`failed`). A signed-out read says so.
 */
export async function loadOfferDefaults(): Promise<OfferDefaults | 'failed' | 'signed-out'> {
  const [options, offers] = await Promise.all([
    callApi<ProductOptions>('GET', 'catalog/seller/products/options'),
    callApi<OfferPage>('GET', DEFAULTS_SOURCE_PATH),
  ]);
  if (
    (!options.ok && options.failure.status === 401) ||
    (!offers.ok && offers.failure.status === 401)
  ) {
    return 'signed-out';
  }
  if (!options.ok) return 'failed';
  return offerDefaultsOf(offers.ok ? offers.body.items : [], options.body.conditions) ?? 'failed';
}

/** The created draft Offer (`POST catalog/seller/offers`). */
export interface Created {
  readonly offerId: string;
}

/** What one "Sell this" needs of a platform product. */
export interface SellableProduct {
  readonly productId: string;
  readonly productCode: string;
}

/**
 * The body that creates one draft Offer on a platform product. The product code is unique in the
 * Market, so it is a free SKU to start from.
 */
export function draftOfferBody(product: SellableProduct, condition: string) {
  return {
    productId: product.productId,
    sellerSku: product.productCode,
    conditionCode: condition,
    description: {},
  };
}

/**
 * Creates one draft Offer with the defaults (Offer page PR 5): the condition goes with the draft,
 * then its handling is recorded. The draft is the result: a handling that could not be recorded
 * leaves it without one, which the seller sets on the Offer (the draft cannot be submitted
 * before), so only a signed-out answer is passed on (`handlingSignedOut`).
 */
export async function createDraftOffer(
  product: SellableProduct,
  defaults: OfferDefaults,
  csrfToken: string,
): Promise<{ readonly result: ApiResult<Created>; readonly handlingSignedOut: boolean }> {
  const result = await callApi<Created>(
    'POST',
    'catalog/seller/offers',
    draftOfferBody(product, defaults.condition),
    csrfToken,
  );
  if (!result.ok) return { result, handlingSignedOut: false };
  const handling = await callApi<unknown>(
    'PUT',
    `catalog/seller/offers/${result.body.offerId}/handling`,
    { handling: defaults.handling },
    csrfToken,
  );
  return { result, handlingSignedOut: !handling.ok && handling.failure.status === 401 };
}
