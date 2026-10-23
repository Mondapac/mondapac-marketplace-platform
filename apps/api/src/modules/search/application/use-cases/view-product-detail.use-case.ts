import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Money, Result, Temporal } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { SearchValidationFailed } from '../../domain/search-query';
import type { ProductDetailDependencies } from '../product-detail-dependencies';
import type { ImageRef } from '../../domain/image-ref';
import { imageRefsOf } from '../product-images';
import { detailKeyOf, type DetailKey } from '../ports/product-detail-sources';

/** How many Offers of one product a page reads: a product with more is shown its first 20 by id. */
export const MAX_DETAIL_OFFERS = 20;
/** The most (Offer, Variant) keys asked of pricing and inventory: both refuse more than 200. */
export const MAX_DETAIL_KEYS = 200;

export interface ProductDetailRequest {
  readonly productId: string;
}

/** One sellable Variant of an Offer with its buyer price and public stock state. */
export interface ProductDetailUnit {
  readonly variantId: Id<'Variant'>;
  readonly label: string | null;
  readonly price: Money;
  readonly taxInclusive: boolean;
  readonly special: { readonly endsAt: Temporal.Instant } | null;
  readonly stock: {
    readonly status: 'in-stock' | 'low' | 'out';
    readonly onlyLeft: number | null;
  };
}

export interface ProductDetailOffer {
  readonly offerId: Id<'Offer'>;
  readonly sellerId: Id<'Seller'>;
  readonly seller: { readonly storeName: string | null; readonly minimumOrder?: Money | null };
  readonly units: readonly ProductDetailUnit[];
}

export interface ProductDetail {
  readonly productId: Id<'Product'>;
  readonly name: string;
  readonly shortDescription: string | null;
  readonly description: string | null;
  readonly categoryIds: readonly Id<'Category'>[];
  /** The product's public photos in the published revision's order, at most 8; may be empty. */
  readonly images: readonly ImageRef[];
  readonly offers: readonly [ProductDetailOffer, ...ProductDetailOffer[]];
}

export type ProductDetailFailure =
  | SearchValidationFailed
  | { readonly code: 'search.product-not-found' }
  | { readonly code: 'search.unavailable' };

/** The lowest unit price of an Offer: all its units are priced in the Market currency. */
const lowestOf = (offer: ProductDetailOffer): bigint =>
  offer.units.reduce(
    (lowest, unit) => (unit.price.amount < lowest ? unit.price.amount : lowest),
    offer.units[0]!.price.amount,
  );

/** Lowest unit price first, ties by Offer id. */
function byLowestPrice(a: ProductDetailOffer, b: ProductDetailOffer): number {
  const [x, y] = [lowestOf(a), lowestOf(b)];
  if (x !== y) return x < y ? -1 : 1;
  return a.offerId < b.offerId ? -1 : a.offerId > b.offerId ? 1 : 0;
}

const NOT_FOUND = { code: 'search.product-not-found' } as const;
const UNAVAILABLE = { code: 'search.unavailable' } as const;

/**
 * `search.view-product-detail`: the buyer product page's data. Rule `anonymous`: no session, the
 * request's Market. The product's indexed Offers (at most {@link MAX_DETAIL_OFFERS}) that catalog
 * and sellers still show are the candidates; catalog gives the published content in the Market's
 * default locale, and each candidate's published sell units that are also Variants of that content
 * are priced (pricing), given a public stock state (inventory, `status` and `onlyLeft` only, never
 * the exact count) and a seller (public store name and minimum order). A unit without a price in
 * the Market currency is dropped, an Offer without a priced unit is dropped, and Offers come
 * lowest unit price first, ties by Offer id. When the keys would exceed {@link MAX_DETAIL_KEYS}
 * the last Offers (by id) are left out before pricing. A product no Offer of which is left is
 * `search.product-not-found`; a source or check that cannot be made is `search.unavailable`.
 * The product's public photos (catalog's published revision only, taken down ones skipped, at
 * most 8) come with the answer; a photo source that cannot answer gives none, never an error.
 * Prices are always Money (amount and currency); never Cost.
 */
export class ViewProductDetail extends UseCase<
  ProductDetailRequest,
  ProductDetail,
  ProductDetailFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'search.view-product-detail',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ProductDetailDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ProductDetailRequest,
  ): Promise<Result<ProductDetail, ProductDetailFailure>> {
    const parsed = typeof input.productId === 'string' ? parseId<'Product'>(input.productId) : null;
    if (parsed === null || !parsed.ok) {
      return err({ code: 'validation.failed', fields: [{ path: 'productId', code: 'format' }] });
    }
    const productId = parsed.value;
    const { market } = context;
    const { locale, currency } = this.deps.policy.settings(market);

    const read = await this.deps.unitOfWork.run(
      market,
      async () => ok(await this.deps.shelves.byProductId(market, productId, MAX_DETAIL_OFFERS)),
      { readOnly: true },
    );
    if (!read.ok) return err(UNAVAILABLE);
    const visible = await this.deps.visibility.visible(context, read.value);
    if (visible === null) return err(UNAVAILABLE);
    const candidates = read.value.filter((hit) => visible.has(hit.offerId));
    if (candidates.length === 0) return err(NOT_FOUND);

    const found = await this.deps.sources.product(context, productId, locale);
    if (found === null) return err(UNAVAILABLE);
    const { product } = found;
    if (product === null) return err(NOT_FOUND);

    const published = await this.deps.variants.published(
      context,
      candidates.map((hit) => hit.offerId),
    );
    if (published === null) return err(UNAVAILABLE);
    const keysOf = new Map<Id<'Offer'>, DetailKey[]>();
    let total = 0;
    for (const hit of candidates) {
      const sellUnits = published.get(hit.offerId);
      const keys = product.variants
        .filter((variant) => sellUnits?.has(variant.variantId) === true)
        .map((variant) => ({ offerId: hit.offerId, variantId: variant.variantId }));
      if (total + keys.length > MAX_DETAIL_KEYS) break;
      total += keys.length;
      keysOf.set(hit.offerId, keys);
    }
    const keys = [...keysOf.values()].flat();
    const offers = candidates.filter((hit) => keysOf.has(hit.offerId));
    const [prices, availability, sellers, imageRefs] = await Promise.all([
      this.deps.sources.prices(context, keys),
      this.deps.sources.availability(context, keys),
      this.deps.sources.sellers(context, [...new Set(offers.map((hit) => hit.sellerId))]),
      imageRefsOf(this.deps.images, context, [{ productId, name: product.name }]),
    ]);
    if (prices === null || availability === null || sellers === null) return err(UNAVAILABLE);

    const labelOf = new Map(product.variants.map((variant) => [variant.variantId, variant.label]));
    const shown = offers.flatMap((hit) => {
      const units = (keysOf.get(hit.offerId) ?? []).flatMap((key): ProductDetailUnit[] => {
        const priced = prices.get(detailKeyOf(key));
        if (priced === undefined || priced.price.currency !== currency) return [];
        const stock = availability.get(detailKeyOf(key));
        return [
          {
            variantId: key.variantId,
            label: labelOf.get(key.variantId) ?? null,
            price: priced.price,
            taxInclusive: priced.taxInclusive,
            special: priced.special,
            stock: stock ?? { status: 'out', onlyLeft: null },
          },
        ];
      });
      if (units.length === 0) return [];
      const seller = sellers.get(hit.sellerId);
      return [
        {
          offerId: hit.offerId,
          sellerId: hit.sellerId,
          seller: seller ?? { storeName: null },
          units,
        },
      ];
    });
    const [first, ...rest] = shown.sort(byLowestPrice);
    if (first === undefined) return err(NOT_FOUND);
    return ok({
      productId,
      name: product.name,
      shortDescription: product.shortDescription,
      description: product.description,
      categoryIds: product.categoryIds,
      images: imageRefs.get(productId) ?? [],
      offers: [first, ...rest],
    });
  }
}
