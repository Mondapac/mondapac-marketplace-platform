import { parseId } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import type { AssistantCart, AssistantOfferUnits, CartAssistantFacade } from '../../cart';
import type { CatalogAssistantFacade } from '../../catalog';
import type { SupportContactFacade } from '../../notifications';
import type { SellersFacade } from '../../sellers';
import type { SettingsFacade } from '../../settings';
import type {
  AssistantProduct,
  AssistantProductDetail,
  AssistantSpecial,
  SearchAssistantFacade,
} from '../../search';
import type { ServiceAreaDirectory } from '../../../platform/market-config/service-area-directory';
import type { AssistantTools, ToolOutcome } from '../application/ports/assistant-tools';
import type { AssistantCard, CartActionCard, CartCard } from '../domain/cards';
import { TOOL_ITEM_LIMIT, type CartChange, type ToolRequest } from '../domain/tools';

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

const CART_PAGE: AssistantCard = Object.freeze({ kind: 'page', page: 'cart', categoryId: null });

const notReady: ToolOutcome = Object.freeze({
  forModel: JSON.stringify({
    status: 'not ready yet: the buyer changes the cart on the cart page',
  }),
  isError: false,
  cards: [CART_PAGE],
  notices: ['cart-actions-not-ready' as const],
});

/** Only a signed-in customer's cart is read here: anyone else gets the cart page link. */
const signInForCart: ToolOutcome = Object.freeze({
  forModel: JSON.stringify({
    error:
      "only a signed-in buyer's cart can be read here; the cart page link is shown. Do not " +
      'guess what is in the cart.',
  }),
  isError: true,
  cards: [CART_PAGE],
  notices: ['cart-sign-in' as const],
});

/** The refusals of a cart read that mean "not a signed-in customer" (not a failed read). */
const NOT_SIGNED_IN: ReadonlySet<string> = new Set([
  'access.unauthenticated',
  'access.denied',
  'access.seller-not-approved',
]);

const notPurchasable: ToolOutcome = Object.freeze({
  forModel: JSON.stringify({
    error: 'this product cannot be added to the cart now; say so and do not guess why',
  }),
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
    offerId: item.offerId,
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
    offerId: offer.offerId,
    sellerId: offer.sellerId,
    storeName: sellerText(offer.sellerName, SHORT_LIMIT),
  })),
  shownToBuyer: 'the product card with the prices and certification badges',
});

/**
 * {@link AssistantTools} on the READ facades of `search`, `catalog` and `notifications`, each
 * called with the buyer's `CallContext` unchanged (ADR-0019 R3). The buyer gets the cards; the
 * model gets names and short texts only, so it has no price or stock figure to repeat. A failed
 * read is reported as such: nothing is guessed. The cart tools build cards from the cart's own
 * reads and change nothing (S1-B1); the in-window support form answers "not ready".
 */
export class FacadeAssistantTools implements AssistantTools {
  constructor(
    private readonly search: SearchAssistantFacade,
    private readonly catalog: CatalogAssistantFacade,
    private readonly support: SupportContactFacade,
    private readonly sellers: SellersFacade,
    private readonly areas: ServiceAreaDirectory,
    private readonly cart: CartAssistantFacade,
    private readonly settings: SettingsFacade,
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
        return request.change === null ? notReady : this.cartChange(context, request.change);
      case 'get_cart':
        return this.ownCart(context);
      case 'plan_basket':
        // Planned by BasketAssistantTools, which wraps this class; never reached through it.
        return failed;
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

  /**
   * The buyer's own cart (signed in only), as the cart card. The model reads line ids, names,
   * quantities and whether each line can be bought now: never a price, total or max.
   */
  private async ownCart(context: CallContext): Promise<ToolOutcome> {
    const read = await this.turnRead(this.carts, context, () => this.cart.ownCart(context));
    // The cart answers only a signed-in customer: anyone else is sent to the cart page.
    if (!read.ok) return NOT_SIGNED_IN.has(read.error.code) ? signInForCart : failed;
    const cart = read.value;
    return shown([cartCardOf(cart)], {
      shownToBuyer: 'the cart card with the prices and totals',
      lineCount: cart.lineCount,
      stores: cart.groups.map((group) => ({
        sellerId: group.sellerId,
        storeName: sellerText(group.sellerName, SHORT_LIMIT),
        lines: group.lines.map((line) => ({
          lineId: line.lineId,
          offerId: line.offerId,
          name: sellerText(line.productName, SHORT_LIMIT),
          size: sellerText(line.variantLabel, SHORT_LIMIT),
          quantity: line.quantity,
          canBuyNow: line.state === 'buyable',
        })),
      })),
    });
  }

  /**
   * A proposed change as a cart-action card (S1-B1). Nothing is written: the card carries what
   * the storefront needs to call the cart's own route after the buyer clicks. An add is checked
   * as the cart's add would check it; a line change needs the signed-in buyer's own line.
   */
  private async cartChange(context: CallContext, change: CartChange): Promise<ToolOutcome> {
    const signedIn =
      context.actor.kind === 'authenticated' && context.actor.population === 'customer';
    if (change.action !== 'add' && !signedIn) return signInForCart;
    // The three reads are independent; the cart and the mode are read once per turn.
    const [cartMode, cart, units] = await Promise.all([
      this.turnRead(this.modes, context, () => this.settings.cartMode(context)),
      signedIn
        ? this.turnRead(this.carts, context, () => this.cart.ownCart(context))
        : Promise.resolve(null),
      change.action === 'add'
        ? this.cart.offerUnits(context, change.offerId)
        : Promise.resolve(null),
    ]);
    // A signed-in buyer's cart that cannot be read is a failed read, never an empty cart.
    if (cart !== null && !cart.ok) return failed;
    const own = cart?.ok ? cart.value : null;
    if (change.action === 'add') {
      if (units === null) return failed;
      if (!units.ok) {
        // A malformed or unknown id, or nothing on sale, is "cannot be added"; else it failed.
        return units.error.code === 'cart.offer-not-purchasable' ||
          units.error.code === 'validation.failed'
          ? notPurchasable
          : failed;
      }
      return this.addCard(change, cartMode, own, units.value);
    }
    if (own === null) return failed;
    return this.lineCard(change, cartMode, own);
  }

  /** Per turn (one `CallContext` a request): the same read is not repeated by later calls. */
  private readonly carts = new WeakMap<CallContext, Promise<unknown>>();
  private readonly modes = new WeakMap<CallContext, Promise<unknown>>();

  private turnRead<T>(
    cache: WeakMap<CallContext, Promise<unknown>>,
    context: CallContext,
    read: () => Promise<T>,
  ): Promise<T> {
    const known = cache.get(context);
    if (known !== undefined) return known as Promise<T>;
    const started = read();
    cache.set(context, started);
    return started;
  }

  private addCard(
    change: Extract<CartChange, { action: 'add' }>,
    cartMode: 'multi-store' | 'single-store',
    cart: AssistantCart | null,
    offer: AssistantOfferUnits,
  ): ToolOutcome {
    const lines = cart?.groups.flatMap((group) => group.lines) ?? [];
    const cartFull = cart === null ? null : cart.lineCount >= cart.maxLines;
    const units = offer.units.map((unit) => {
      const line = lines.find(
        (item) => item.offerId === offer.offerId && item.variantId === unit.variantId,
      );
      const inCart = cart === null ? null : (line?.quantity ?? 0);
      // The cart's add caps the sum, and refuses a new line in a full cart (design 6.1).
      const addable =
        line === undefined && cartFull === true ? 0 : Math.max(0, unit.maxQuantity - (inCart ?? 0));
      return {
        variantId: unit.variantId,
        label: unit.label,
        price: unit.unitPrice,
        taxInclusive: unit.taxInclusive,
        maxQuantity: unit.maxQuantity,
        lineId: line?.lineId ?? null,
        inCart,
        addable,
      };
    });
    const most = Math.max(...units.map((unit) => unit.addable));
    if (most <= 0) {
      return {
        forModel: JSON.stringify({
          error:
            cartFull === true
              ? 'the cart is full; the buyer must remove something first; no card'
              : 'the cart already holds the most it can of this product; no card',
        }),
        isError: true,
        cards: [],
        notices: [],
      };
    }
    const quantity = Math.min(change.quantity, most);
    // A store whose check failed is unknown, never "another store"; a known other store wins.
    const groups = cart?.groups.filter((group) => group.lines.length > 0) ?? [];
    const otherStore =
      cartMode === 'multi-store'
        ? false
        : cart === null
          ? null
          : groups.some((group) => group.sellerId !== null && group.sellerId !== offer.sellerId)
            ? true
            : groups.some((group) => group.sellerId === null)
              ? null
              : false;
    const card: CartActionCard = {
      kind: 'cart-action',
      action: 'add',
      offerId: offer.offerId,
      productId: offer.productId,
      sellerId: offer.sellerId,
      sellerName: offer.sellerName,
      name: offer.productName,
      lineId: null,
      currentQuantity: null,
      quantity,
      limited: quantity < change.quantity,
      cartFull,
      units,
      cartMode,
      otherStore,
    };
    return shown([card], {
      shownToBuyer: 'a card to add the product to the cart; only the buyer can confirm it',
      product: sellerText(offer.productName, SHORT_LIMIT),
      store: sellerText(offer.sellerName, SHORT_LIMIT),
      sizesToPickFrom: units.length,
      quantityLowered: card.limited,
      alreadyInCart: cart === null ? 'unknown' : units.some((unit) => (unit.inCart ?? 0) > 0),
      otherStoreInCart: otherStore,
      note:
        otherStore === true
          ? 'this store sells in single-store mode: the card asks the buyer what to do with ' +
            'the other store first'
          : undefined,
    });
  }

  private lineCard(
    change: Exclude<CartChange, { action: 'add' }>,
    cartMode: 'multi-store' | 'single-store',
    cart: AssistantCart,
  ): ToolOutcome {
    const group = cart.groups.find((item) =>
      item.lines.some((line) => line.lineId === change.lineId),
    );
    const line = group?.lines.find((item) => item.lineId === change.lineId);
    if (group === undefined || line === undefined) return notFound;
    let quantity = change.action === 'remove' ? 0 : change.quantity;
    let limited = false;
    if (change.action === 'set-quantity') {
      if (quantity === line.quantity) {
        return {
          forModel: JSON.stringify({ status: 'the line already has this quantity; no card' }),
          isError: false,
          cards: [],
          notices: [],
        };
      }
      // A line that cannot be bought now can be lowered, never raised (cart design 6.1).
      if (line.maxQuantity === null && quantity > line.quantity) {
        return {
          forModel: JSON.stringify({
            error: 'this item cannot be bought now, so its quantity can only be lowered or removed',
          }),
          isError: true,
          cards: [],
          notices: [],
        };
      }
      if (line.maxQuantity !== null && quantity > line.maxQuantity) {
        quantity = line.maxQuantity;
        limited = true;
      }
    }
    const card: CartActionCard = {
      kind: 'cart-action',
      action: change.action,
      offerId: line.offerId,
      productId: line.productId,
      sellerId: group.sellerId,
      sellerName: group.sellerName,
      name: line.productName,
      lineId: line.lineId,
      currentQuantity: line.quantity,
      quantity,
      limited,
      cartFull: null,
      units: [
        {
          variantId: line.variantId,
          label: line.variantLabel,
          price: line.unitPrice,
          taxInclusive: null,
          maxQuantity: line.maxQuantity,
          lineId: line.lineId,
          inCart: line.quantity,
          addable: null,
        },
      ],
      cartMode,
      otherStore: false,
    };
    return shown([card], {
      shownToBuyer:
        change.action === 'remove'
          ? 'a card to remove the line; only the buyer can confirm it'
          : 'a card to change the quantity; only the buyer can confirm it',
      product: sellerText(line.productName, SHORT_LIMIT),
      quantityLowered: limited,
    });
  }
}

/** The cart card: the cart's own composition, ids and Money only. */
function cartCardOf(cart: AssistantCart): CartCard {
  return {
    kind: 'cart',
    lineCount: cart.lineCount,
    total: cart.total,
    groups: cart.groups.map((group) => ({
      sellerId: group.sellerId,
      sellerName: group.sellerName,
      subtotal: group.subtotal,
      minimumOrder: group.minimumOrder,
      lines: group.lines.map((line) => ({
        lineId: line.lineId,
        offerId: line.offerId,
        variantId: line.variantId,
        productId: line.productId,
        name: line.productName,
        variantLabel: line.variantLabel,
        quantity: line.quantity,
        state: line.state,
        unitPrice: line.unitPrice,
        maxQuantity: line.maxQuantity,
      })),
    })),
  };
}
