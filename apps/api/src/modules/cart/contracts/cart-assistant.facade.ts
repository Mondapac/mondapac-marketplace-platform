import type { CallContext, Id, Money, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';

/** At most this many sell units of one Offer are answered (the buyer picks one of them). */
export const MAX_ASSISTANT_SELL_UNITS = 10;

/** One line of the signed-in buyer's own cart as the buyer assistant shows it. */
export interface AssistantCartLine {
  readonly lineId: Id<'CartLine'>;
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
  readonly productId: Id<'Product'> | null;
  /** Published names, seller-entered text: escape it. Null when catalog did not answer. */
  readonly productName: string | null;
  readonly variantLabel: string | null;
  readonly quantity: number;
  readonly state: 'buyable' | 'unavailable' | 'check-unavailable';
  /** The current buyer price of one unit (Money, never Cost); null when it cannot be read. */
  readonly unitPrice: Money | null;
  /**
   * The highest quantity the cart accepts for this line now: the Market's line ceiling, lowered
   * by the stock read only while it is low (cart design 6.1). Null when the line is not buyable.
   */
  readonly maxQuantity: number | null;
}

/** The lines of one store, with the cart evaluator's subtotal and minimum-order state. */
export interface AssistantCartGroup {
  readonly sellerId: Id<'Seller'> | null;
  readonly sellerName: string | null;
  /** The buyable lines at the current price; null when there are none or currencies mix. */
  readonly subtotal: Money | null;
  readonly minimumOrder: {
    readonly state: 'not-applicable' | 'none' | 'met' | 'below-minimum' | 'check-unavailable';
    readonly minimum: Money | null;
  };
  readonly lines: readonly AssistantCartLine[];
}

/** The signed-in buyer's own active cart, composed as the cart page composes it. */
export interface AssistantCart {
  readonly groups: readonly AssistantCartGroup[];
  readonly lineCount: number;
  /** The most lines one cart may hold in the Market: a new line is refused at this count. */
  readonly maxLines: number;
  /** The sum of the store subtotals; null when a subtotal is unknown or currencies mix. */
  readonly total: Money | null;
}

/** One sell unit of an Offer that can be added to a cart now. */
export interface AssistantSellUnit {
  readonly variantId: Id<'Variant'>;
  /** The published Variant label, seller-entered text; null when there is none. */
  readonly label: string | null;
  readonly unitPrice: Money;
  readonly taxInclusive: boolean | null;
  /** The highest quantity one cart line of it may hold now (ceiling, or the low stock). */
  readonly maxQuantity: number;
}

/** What can be added of one Offer now, as the cart's add would check it (cart design 6.1). */
export interface AssistantOfferUnits {
  readonly offerId: Id<'Offer'>;
  readonly sellerId: Id<'Seller'>;
  readonly sellerName: string | null;
  readonly productId: Id<'Product'>;
  /** The published product name, seller-entered text; null when catalog did not answer. */
  readonly productName: string | null;
  /** The buyable units, at most {@link MAX_ASSISTANT_SELL_UNITS}, in catalog's order. */
  readonly units: readonly AssistantSellUnit[];
}

export type AssistantCartFailure =
  | AccessDenied
  | { readonly code: 'validation.failed' }
  /** Unknown, another Market's, not listed, or no unit is on sale now. */
  | { readonly code: 'cart.offer-not-purchasable' }
  /** A store could not be asked; nothing is guessed. */
  | { readonly code: 'cart.check-unavailable' };

/**
 * The cart reads of the buyer assistant's cart cards (stage 1, S1-B1). Read only: the assistant
 * never changes a cart; the storefront calls the cart's own routes with the buyer's session after
 * the buyer clicks (ADR-0019 R4). Each method passes the caller's `CallContext` unchanged to one
 * use case, so the gate runs.
 */
export interface CartAssistantFacade {
  /**
   * The signed-in customer's own active cart (rule `own-resources`; a guest or any other actor
   * is refused with `access.denied`). An empty cart is an answer with no groups.
   */
  ownCart(context: CallContext): Promise<Result<AssistantCart, AssistantCartFailure>>;

  /**
   * The units of one Offer a buyer could add now, each with its price and the highest quantity
   * (rule `anonymous`: what the product page shows). Advisory only: the cart's add checks again.
   */
  offerUnits(
    context: CallContext,
    offerId: string,
  ): Promise<Result<AssistantOfferUnits, AssistantCartFailure>>;
}

/** Nest token of the {@link CartAssistantFacade}, provided and exported by `CartModule`. */
export const CART_ASSISTANT_FACADE = Symbol('CART_ASSISTANT_FACADE');
