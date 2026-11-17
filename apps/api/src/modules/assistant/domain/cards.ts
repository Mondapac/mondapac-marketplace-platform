import type { Money } from '@mondapac/shared-kernel';
import type { BasketProposal } from './plan-basket';
import type { SitePage } from './tools';

/**
 * What the buyer sees of a tool result: a card built by the server from the owning module's data,
 * never from model text (plan section 5, guardrail 1). The storefront renders each card with its
 * own components and builds every link from these ids (R9).
 */
export type AssistantCard =
  | {
      readonly kind: 'product';
      readonly offerId: string;
      readonly productId: string;
      readonly sellerId: string;
      readonly name: string;
      readonly shortText: string | null;
      /** The public store name of the seller, as sellers answered it; null when unreadable. */
      readonly sellerName: string | null;
      /**
       * The lowest buyer price of the Offer now, as pricing answered it (Money, never Cost); null
       * when pricing could not be read, and then the card shows none. Never from model text.
       */
      readonly price: Money | null;
      /** The regular price, only while `price` is a special. */
      readonly regularPrice: Money | null;
      readonly taxInclusive: boolean | null;
      /** True when the Offer has Variants at different prices: `price` is then a "from" price. */
      readonly priceFrom: boolean;
      /**
       * Certification badges as catalog answered them live, only on the card of `get_product`.
       * Display only: never model text and never an input to `evaluateClaim` (ADR-0019 R1).
       */
      readonly badges: readonly {
        readonly typeCode: string;
        readonly typeName: string;
        /** True when the seller only declared it: the storefront shows it as it does on the page. */
        readonly sellerClaim: boolean;
      }[];
    }
  | {
      readonly kind: 'seller';
      readonly sellerId: string;
      /** The store's own page address (`/stores/<slug>`); the storefront builds the link. */
      readonly slug: string;
      readonly name: string;
      readonly city: string | null;
      readonly sellingSince: number;
      /** How many products the store has on sale; null means unknown, never zero. */
      readonly productCount: number | null;
    }
  /**
   * A shopping list planned by the server (`plan_basket`): the products, packs, stores and totals
   * all come from {@link BasketProposal}, never from model text. The storefront shows it with an
   * edit step and adds to the cart only when the buyer clicks, with the buyer's own session.
   */
  | { readonly kind: 'basket-proposal'; readonly proposal: BasketProposal }
  | CartActionCard
  | CartCard
  | { readonly kind: 'page'; readonly page: SitePage; readonly categoryId: string | null }
  | { readonly kind: 'support'; readonly email: string | null };

/** One sell unit a cart-action card offers; the buyer picks one when there are several. */
export interface CartActionUnit {
  readonly variantId: string;
  /** The published Variant label (seller-entered text; the storefront escapes it), or null. */
  readonly label: string | null;
  /** The buyer price of one unit now, from pricing through the cart (never Cost, never model text). */
  readonly price: Money | null;
  readonly taxInclusive: boolean | null;
  /** "max N": the most one cart line of it may hold now; null when it cannot be bought now. */
  readonly maxQuantity: number | null;
  /** The buyer's cart line of this unit; null when none or the cart is unread. */
  readonly lineId: string | null;
  /** The quantity of that line; 0 when none; null when the cart is unread (a guest). */
  readonly inCart: number | null;
  /**
   * How many more of this unit the cart accepts now: `maxQuantity - inCart` (the cart's add caps
   * the sum), 0 when the cart is full and this unit has no line yet; `maxQuantity` when the cart
   * is unread. Null on line cards. The widget clamps the card's `quantity` to the chosen unit's
   * `addable` and offers no button for a unit at 0.
   */
  readonly addable: number | null;
}

/**
 * A proposed cart change (stage 1, S1-B1). Built by the server from the cart's own reads, never
 * from model text, and never applied by the server: the storefront calls the cart's own routes
 * with the buyer's session and CSRF token only after the buyer clicks (ADR-0019 R4).
 * - `add`: POST cart items with `units[i].variantId` and `quantity` (how many more).
 * - `set-quantity`: PUT the line `lineId` to `quantity` (the new total).
 * - `remove`: DELETE the line `lineId` (`quantity` is 0).
 */
export interface CartActionCard {
  readonly kind: 'cart-action';
  readonly action: 'add' | 'set-quantity' | 'remove';
  readonly offerId: string;
  readonly productId: string | null;
  readonly sellerId: string | null;
  /** The public store name, as the cart answered it; null when unreadable. */
  readonly sellerName: string | null;
  /** The published product name (seller-entered text), or null. */
  readonly name: string | null;
  /** For `set-quantity` and `remove`: the line; for `add`: null (see the units). */
  readonly lineId: string | null;
  /** For `set-quantity` and `remove`: the line's quantity now. */
  readonly currentQuantity: number | null;
  /**
   * add: how many more, already lowered to the `addable` of the unit when there is one unit, or to
   * the largest `addable` when the buyer picks among several (the widget clamps for the chosen
   * one); set-quantity: the new total, lowered to the line's max; remove: 0.
   */
  readonly quantity: number;
  /** True when the proposed quantity was lowered (the card says "max N"). */
  readonly limited: boolean;
  /** add only: true when the cart holds its most lines (a unit with no line cannot be added). */
  readonly cartFull: boolean | null;
  /** One to ten units, in catalog's order; the line's own unit for `set-quantity` and `remove`. */
  readonly units: readonly CartActionUnit[];
  readonly cartMode: 'multi-store' | 'single-store';
  /**
   * `single-store` only: true when the buyer's cart holds lines of another store, so the widget
   * first asks to move them to saved items or remove them; null when it is not known (a guest's
   * cart is not read here, or a line's store could not be checked): the widget then reads the
   * cart itself first, and null never means "safe". Always false in `multi-store`.
   */
  readonly otherStore: boolean | null;
}

/** The signed-in buyer's own cart, as the cart page composes it (stage 1, S1-B1). */
export interface CartCard {
  readonly kind: 'cart';
  readonly lineCount: number;
  /** The sum of the store subtotals; null when one is unknown or currencies mix. */
  readonly total: Money | null;
  readonly groups: readonly {
    readonly sellerId: string | null;
    readonly sellerName: string | null;
    readonly subtotal: Money | null;
    readonly minimumOrder: {
      readonly state: 'not-applicable' | 'none' | 'met' | 'below-minimum' | 'check-unavailable';
      readonly minimum: Money | null;
    };
    readonly lines: readonly {
      readonly lineId: string;
      readonly offerId: string;
      readonly variantId: string;
      readonly productId: string | null;
      readonly name: string | null;
      readonly variantLabel: string | null;
      readonly quantity: number;
      readonly state: 'buyable' | 'unavailable' | 'check-unavailable';
      readonly unitPrice: Money | null;
      readonly maxQuantity: number | null;
    }[];
  }[];
}

/**
 * A fixed message the storefront shows in the buyer's language:
 * - `see-cards`, `see-certification`: the guard removed a claim (reply-guard.ts).
 * - `cart-actions-not-ready`: cart cards are not in the Market's scope (`read-only`).
 * - `support-form-not-ready`: the in-window support form is not built yet (plan section 11).
 * - `cart-sign-in`: the buyer's cart can be read here only when signed in; the cart page link
 *   follows.
 * - `unavailable`: the model could not answer; the storefront offers its normal search.
 * - `refused`: the model declined; the support card follows.
 * - `tool-failed`: a store read failed; nothing was guessed.
 */
export type AssistantNotice =
  | 'see-cards'
  | 'see-certification'
  | 'cart-actions-not-ready'
  | 'support-form-not-ready'
  | 'cart-sign-in'
  | 'unavailable'
  | 'refused'
  | 'tool-failed';

/**
 * The kind of every card in a reply, as stored with it (ids only, no text). A cart-action card is
 * kept as its product and a cart card as the cart page link: history never replays an action
 * button or an old cart.
 */
export const cardRefOf = (card: AssistantCard): string =>
  card.kind === 'product' || card.kind === 'cart-action'
    ? `product:${card.offerId}`
    : card.kind === 'cart'
      ? 'page:cart'
      : card.kind === 'seller'
        ? `seller:${card.sellerId}`
        : card.kind === 'basket-proposal'
          ? 'basket'
          : card.kind === 'page'
            ? `page:${card.page}`
            : 'support';
