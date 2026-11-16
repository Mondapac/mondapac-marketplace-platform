import { parseId } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import type { CatalogAssistantFacade } from '../../catalog';
import type { SupportContactFacade } from '../../notifications';
import type { SellersFacade } from '../../sellers';
import type {
  AssistantProduct,
  AssistantProductDetail,
  AssistantSpecial,
  SearchAssistantFacade,
} from '../../search';
import type { ServiceAreaDirectory } from '../../../platform/market-config/service-area-directory';
import type { AssistantTools, ToolOutcome } from '../application/ports/assistant-tools';
import type { AssistantCard } from '../domain/cards';
import { TOOL_ITEM_LIMIT, type ToolRequest } from '../domain/tools';

const shown = (cards: readonly AssistantCard[], forModel: unknown): ToolOutcome => ({
  forModel: JSON.stringify(forModel),
  isError: false,
  cards,
  notices: [],
});

const notFound: ToolOutcome = Object.freeze({
  forModel: JSON.stringify({ error: 'not found in this store; say so and do not guess' }),
  isError: true,
  cards: [],
  notices: [],
});

const failed: ToolOutcome = Object.freeze({
  forModel: JSON.stringify({ error: 'could not read the store; say so and do not guess' }),
  isError: true,
  cards: [],
  notices: ['tool-failed' as const],
});

const productCard = (item: AssistantProduct | AssistantSpecial): AssistantCard => ({
  kind: 'product',
  offerId: item.offerId,
  productId: item.productId,
  sellerId: item.sellerId,
  name: item.name,
  shortText: item.shortText,
  sellerName: item.sellerName,
  price: item.price,
  regularPrice: item.regularPrice,
  taxInclusive: item.taxInclusive,
  priceFrom: item.priceFrom,
  badges: [],
});

/**
 * What the model reads of a product: ids (to ask for more), name and short text only, never a
 * price or stock.
 */
const forModelOf = (items: readonly AssistantProduct[]) => ({
  shownToBuyer: items.length,
  products: items.map((item) => ({
    productId: item.productId,
    sellerId: item.sellerId,
    name: sellerText(item.name, SHORT_LIMIT),
    shortText: sellerText(item.shortText, SHORT_LIMIT),
  })),
});

const TEXT_LIMIT = 1500;
const SHORT_LIMIT = 200;
const ATTRIBUTE_LIMIT = 20;
const SELLERS_LIMIT = 5;

/** Seller-entered text as delimited data: the marker cannot be forged from inside the text. */
export const sellerText = (value: string | null, limit = TEXT_LIMIT): string | null =>
  value === null || value.trim() === ''
    ? null
    : `<<seller-text ${value.replace(/<<seller-text|seller-text>>/gi, ' ').slice(0, limit)} seller-text>>`;

const detailForModel = (detail: AssistantProductDetail) => ({
  productId: detail.productId,
  name: sellerText(detail.name, SHORT_LIMIT),
  brand: sellerText(detail.brandName, SHORT_LIMIT),
  shortDescription: sellerText(detail.shortDescription),
  description: sellerText(detail.description),
  attributes: detail.attributes.slice(0, ATTRIBUTE_LIMIT).map(({ name, value }) => ({
    name: sellerText(name, SHORT_LIMIT),
    value: sellerText(value, SHORT_LIMIT),
  })),
  soldBy: detail.offers.slice(0, SELLERS_LIMIT).map((offer) => ({
    sellerId: offer.sellerId,
    storeName: sellerText(offer.sellerName, SHORT_LIMIT),
  })),
  shownToBuyer: 'the product card with the prices and certification badges',
});

/**
 * {@link AssistantTools} on the READ facades of `search`, `catalog` and `notifications`, each
 * called with the buyer's `CallContext` unchanged (ADR-0019 R3). The buyer gets the cards; the
 * model gets names and short texts only, so it has no price or stock figure to repeat. A failed
 * read is reported as such: nothing is guessed. The two actions not built yet answer "not ready".
 */
export class FacadeAssistantTools implements AssistantTools {
  constructor(
    private readonly search: SearchAssistantFacade,
    private readonly catalog: CatalogAssistantFacade,
    private readonly support: SupportContactFacade,
    private readonly sellers: SellersFacade,
    private readonly areas: ServiceAreaDirectory,
  ) {}

  async run(context: CallContext, request: ToolRequest): Promise<ToolOutcome> {
    try {
      return await this.dispatch(context, request);
    } catch {
      return failed;
    }
  }

  private async dispatch(context: CallContext, request: ToolRequest): Promise<ToolOutcome> {
    switch (request.tool) {
      case 'search_products': {
        const found = await this.search.searchProducts(context, {
          text: request.text,
          categoryId: request.categoryId,
          limit: TOOL_ITEM_LIMIT,
        });
        if (!found.ok) return failed;
        return shown(found.value.map(productCard), forModelOf(found.value));
      }
      case 'list_bestsellers': {
        const found = await this.search.bestsellers(context, {
          categoryId: request.categoryId,
          limit: TOOL_ITEM_LIMIT,
        });
        if (!found.ok) return failed;
        return shown(found.value.map(productCard), forModelOf(found.value));
      }
      case 'list_specials': {
        const found = await this.search.specials(context, {
          categoryId: request.categoryId,
          limit: TOOL_ITEM_LIMIT,
        });
        if (!found.ok) return failed;
        return shown(found.value.map(productCard), forModelOf(found.value));
      }
      case 'get_product': {
        const found = await this.search.productDetail(context, request.productId);
        if (!found.ok) {
          return found.error.code === 'not-found' ? notFound : failed;
        }
        const detail = found.value;
        const [cheapest] = detail.offers;
        return shown(
          [
            {
              kind: 'product',
              offerId: cheapest.offerId,
              productId: detail.productId,
              sellerId: cheapest.sellerId,
              name: detail.name,
              shortText: detail.shortDescription,
              sellerName: cheapest.sellerName,
              price: cheapest.price,
              regularPrice: null,
              taxInclusive: cheapest.taxInclusive,
              priceFrom: cheapest.priceFrom,
              badges: cheapest.badges,
            },
          ],
          detailForModel(detail),
        );
      }
      case 'get_seller':
        return this.seller(context, request.sellerId);
      case 'list_categories': {
        const tree = await this.catalog.categories(context);
        if (!tree.ok) return failed;
        return shown([], {
          categories: tree.value.map(({ id, parentId, name }) => ({ id, parentId, name })),
        });
      }
      case 'show_page':
        return shown([{ kind: 'page', page: request.page, categoryId: request.categoryId }], {
          shownToBuyer: 'link card',
        });
      case 'support_contact': {
        const email = await this.support.publicEmail(context);
        return shown([{ kind: 'support', email }], { shownToBuyer: 'support contact card' });
      }
      case 'suggest_cart_change':
        return {
          forModel: JSON.stringify({
            status: 'not ready yet: the buyer changes the cart on the cart page',
          }),
          isError: false,
          cards: [{ kind: 'page', page: 'cart', categoryId: null }],
          notices: ['cart-actions-not-ready'],
        };
      case 'open_support_form': {
        const email = await this.support.publicEmail(context);
        return {
          forModel: JSON.stringify({ status: 'not ready yet: the support contact card is shown' }),
          isError: false,
          cards: [{ kind: 'support', email }],
          notices: ['support-form-not-ready'],
        };
      }
    }
  }

  /** The public store card of one seller: sellers' store page read, certification, search count. */
  private async seller(context: CallContext, sellerId: string): Promise<ToolOutcome> {
    const parsed = parseId<'Seller'>(sellerId);
    if (!parsed.ok) return notFound;
    const slugs = await this.sellers.publishedStoreSlugs(context, [parsed.value]);
    if (!slugs.ok) return failed;
    const slug = slugs.value.get(parsed.value);
    if (slug === undefined) return notFound;
    const store = await this.sellers.publishedStore(context, slug);
    if (!store.ok) return store.error.code === 'sellers.store-not-found' ? notFound : failed;
    const { name, serviceAreaCode, sellingSince } = store.value;
    const city =
      this.areas.areasOf(context.market.marketId).find((area) => area.code === serviceAreaCode)
        ?.names['en'] ?? null;
    const productCount = await this.search.storeProductCount(context, { slug, name });
    return shown([{ kind: 'seller', sellerId, slug, name, city, sellingSince, productCount }], {
      sellerId,
      storeName: sellerText(name, SHORT_LIMIT),
      city: sellerText(city, SHORT_LIMIT),
      sellingSince,
      productCount,
      shownToBuyer: 'the store card',
    });
  }
}
