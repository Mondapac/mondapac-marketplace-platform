import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { ListBestsellers } from '../application/use-cases/list-bestsellers.use-case';
import type { ListSpecials } from '../application/use-cases/list-specials.use-case';
import type { SearchProducts } from '../application/use-cases/search-products.use-case';
import type { SearchStores } from '../application/use-cases/search-stores.use-case';
import type {
  ProductDetail,
  ViewProductDetail,
} from '../application/use-cases/view-product-detail.use-case';
import type {
  AssistantOffer,
  AssistantProduct,
  AssistantProductDetail,
  AssistantSearchFailure,
  AssistantSpecial,
  SearchAssistantFacade,
} from '../contracts';

/** The facts of one result before the card's price and store name are read. */
type Found = Pick<AssistantProduct, 'offerId' | 'productId' | 'sellerId' | 'name' | 'shortText'>;

const factsOf = (item: Found): Found => ({
  offerId: item.offerId,
  productId: item.productId,
  sellerId: item.sellerId,
  name: item.name,
  shortText: item.shortText,
});

/** Any refusal but validation is "unavailable" to the assistant: it says it could not read. */
const failureOf = (code: string): AssistantSearchFailure => ({
  code: code === 'validation.failed' ? 'validation.failed' : 'search.unavailable',
});

const lowestUnit = (units: ProductDetail['offers'][number]['units']) =>
  units.reduce((low, unit) => (unit.price.amount < low.price.amount ? unit : low), units[0]!);

/** The Offer as the assistant reads it: the cheapest unit's price, never a stock figure. */
function offerOf(offer: ProductDetail['offers'][number]): AssistantOffer {
  const low = lowestUnit(offer.units);
  return {
    offerId: offer.offerId,
    sellerId: offer.sellerId,
    sellerName: offer.seller.storeName,
    price: low.price,
    taxInclusive: low.taxInclusive,
    priceFrom: offer.units.some((unit) => unit.price.amount !== low.price.amount),
    badges: offer.badges.map(({ typeCode, typeName, sellerClaim }) => ({
      typeCode,
      typeName,
      sellerClaim,
    })),
  };
}

const textOf = (
  value: ProductDetail['specifications'][number]['specifications'][number]['value'],
) => {
  switch (value.kind) {
    case 'text':
      return value.text;
    case 'list':
      return value.items.join(', ');
    case 'number':
    case 'date':
      return value.value;
    case 'boolean':
      return value.value ? 'yes' : 'no';
    case 'measure':
      return `${value.value} ${value.unitLabel}`;
  }
};

/** Passes the caller's `CallContext` unchanged to one storefront use case each, so the gate runs. */
export class SearchAssistantFacadeImplementation implements SearchAssistantFacade {
  constructor(
    private readonly search: SearchProducts,
    private readonly bestsellerShelf: ListBestsellers,
    private readonly specialShelf: ListSpecials,
    private readonly detail: ViewProductDetail,
    private readonly stores: SearchStores,
  ) {}

  async searchProducts(
    context: CallContext,
    query: Parameters<SearchAssistantFacade['searchProducts']>[1],
  ): Promise<Result<readonly AssistantProduct[], AssistantSearchFailure>> {
    const result = await this.search.execute(context, {
      q: query.text ?? undefined,
      category: query.categoryId ?? undefined,
      page: 1,
      pageSize: query.limit,
    });
    return result.ok
      ? { ok: true, value: await this.withCardFacts(context, result.value.items.map(factsOf)) }
      : { ok: false, error: failureOf(result.error.code) };
  }

  async bestsellers(
    context: CallContext,
    query: Parameters<SearchAssistantFacade['bestsellers']>[1],
  ): Promise<Result<readonly AssistantProduct[], AssistantSearchFailure>> {
    const result = await this.bestsellerShelf.execute(context, {
      category: query.categoryId ?? undefined,
      limit: query.limit,
    });
    return result.ok
      ? { ok: true, value: await this.withCardFacts(context, result.value.items.map(factsOf)) }
      : { ok: false, error: failureOf(result.error.code) };
  }

  async specials(
    context: CallContext,
    query: Parameters<SearchAssistantFacade['specials']>[1],
  ): Promise<Result<readonly AssistantSpecial[], AssistantSearchFailure>> {
    const result = await this.specialShelf.execute(context, {
      category: query.categoryId ?? undefined,
      limit: query.limit,
    });
    if (!result.ok) return { ok: false, error: failureOf(result.error.code) };
    const { items } = result.value;
    // The shelf's own price is the special; the page read adds only the public store name.
    const names = await this.sellerNames(context, items.map(factsOf));
    return {
      ok: true,
      value: items.map((item) => ({
        ...factsOf(item),
        sellerName: names.get(item.sellerId) ?? null,
        price: item.price,
        regularPrice: item.regularPrice,
        taxInclusive: item.taxInclusive,
        priceFrom: false,
      })),
    };
  }

  async productDetail(
    context: CallContext,
    productId: string,
  ): Promise<
    Result<AssistantProductDetail, AssistantSearchFailure | { readonly code: 'not-found' }>
  > {
    const result = await this.detail.execute(context, { productId });
    if (!result.ok) {
      return result.error.code === 'search.product-not-found'
        ? { ok: false, error: { code: 'not-found' } }
        : { ok: false, error: failureOf(result.error.code) };
    }
    const page = result.value;
    const [first, ...rest] = page.offers
      .map(offerOf)
      .sort((a, b) =>
        a.price.amount !== b.price.amount
          ? a.price.amount < b.price.amount
            ? -1
            : 1
          : a.offerId < b.offerId
            ? -1
            : 1,
      );
    if (first === undefined) return { ok: false, error: { code: 'not-found' } };
    return {
      ok: true,
      value: {
        productId: page.productId,
        name: page.name,
        shortDescription: page.shortDescription,
        description: page.description,
        brandName: page.brand?.name ?? null,
        attributes: page.specifications.flatMap((group) =>
          group.specifications.map(({ name, value }) => ({ name, value: textOf(value) })),
        ),
        offers: [first, ...rest],
      },
    };
  }

  async storeProductCount(
    context: CallContext,
    store: { readonly slug: string; readonly name: string },
  ): Promise<number | null> {
    // The store query is by name (2 to 100 characters); the address picks the store out of it.
    const query = store.name.trim().slice(0, 100);
    if (query.length < 2) return null;
    const result = await this.stores.execute(context, { q: query, page: 1, pageSize: 48 });
    if (!result.ok) return null;
    return result.value.items.find((item) => item.slug === store.slug)?.productCount ?? null;
  }

  /** The cheapest unit price and the store name of each result, from the product page read. */
  private async withCardFacts(
    context: CallContext,
    items: readonly Found[],
  ): Promise<readonly AssistantProduct[]> {
    const pages = await this.pagesOf(context, items);
    return items.map((item) => {
      const hit = pages.get(item.productId)?.offers.find((offer) => offer.offerId === item.offerId);
      const offer = hit === undefined ? undefined : offerOf(hit);
      return {
        ...item,
        sellerName: offer?.sellerName ?? null,
        price: offer?.price ?? null,
        regularPrice: null,
        taxInclusive: offer?.taxInclusive ?? null,
        priceFrom: offer?.priceFrom ?? false,
      };
    });
  }

  private async sellerNames(
    context: CallContext,
    items: readonly Found[],
  ): Promise<ReadonlyMap<Id<'Seller'>, string | null>> {
    const pages = await this.pagesOf(context, items);
    const names = new Map<Id<'Seller'>, string | null>();
    for (const item of items) {
      const offer = pages.get(item.productId)?.offers.find((hit) => hit.offerId === item.offerId);
      if (offer !== undefined) names.set(item.sellerId, offer.seller.storeName);
    }
    return names;
  }

  /** One product page read per distinct product; a failed read leaves the product out. */
  private async pagesOf(
    context: CallContext,
    items: readonly Found[],
  ): Promise<ReadonlyMap<Id<'Product'>, ProductDetail>> {
    const ids = [...new Set(items.map((item) => item.productId))];
    const reads = await Promise.all(
      ids.map(async (productId) => {
        try {
          const read = await this.detail.execute(context, { productId });
          return read.ok ? ([productId, read.value] as const) : null;
        } catch {
          return null;
        }
      }),
    );
    return new Map(reads.flatMap((read) => (read === null ? [] : [read])));
  }
}
