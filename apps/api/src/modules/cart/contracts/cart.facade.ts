import type { CallContext, Id, Money, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';

/** One cart line as checkout needs it: the sell unit, the quantity and what the others say now. */
export interface CheckoutLine {
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
  readonly quantity: number;
  /** `buyable` only when the Offer, the seller, the price and the stock all allow a purchase. */
  readonly state: 'buyable' | 'unavailable' | 'check-unavailable';
  readonly sellerId: Id<'Seller'> | null;
  readonly unitPrice: Money | null;
  readonly taxInclusive: boolean | null;
}

/** A seller that stops checkout (cart design 6.4, 6.6). The minimum is public. */
export interface CartNotReadySeller {
  readonly sellerId: Id<'Seller'>;
  /** `below-minimum`: under the seller's minimum order. `check-unavailable`: it cannot be checked. */
  readonly reason: 'below-minimum' | 'check-unavailable';
  readonly minimum: Money | null;
}

export type CartCheckoutFailure =
  | AccessDenied
  | { readonly code: 'cart.check-unavailable' }
  | {
      readonly code: 'cart.not-ready';
      readonly details: { readonly sellers: readonly CartNotReadySeller[] };
    };

/** The cart as `ordering` reads it (checkout) and clears it (after payment). */
export interface CartCheckoutFacade {
  /**
   * The signed-in customer's cart lines with the current price and state of each (composed
   * the way the cart view is; a failed facade makes a line `check-unavailable`). Customer only.
   * Refuses with `cart.not-ready` and `details.sellers` while a seller with a buyable line is
   * below its minimum order or its minimum cannot be checked (design 6.4, 6.6).
   */
  checkoutLines(
    context: CallContext,
  ): Promise<Result<readonly CheckoutLine[], CartCheckoutFailure>>;

  /**
   * Removes the ordered sell units from the account's active cart. System actor only. Units not
   * in the cart are ignored, so a repeat does nothing.
   */
  clearOrdered(
    context: CallContext,
    request: {
      readonly accountId: Id<'Account'>;
      readonly units: readonly {
        readonly offerId: Id<'Offer'>;
        readonly variantId: Id<'Variant'>;
      }[];
    },
  ): Promise<
    Result<{ readonly removed: number }, AccessDenied | { readonly code: 'conflict.stale' }>
  >;
}

/** Nest token of the {@link CartCheckoutFacade}, provided and exported by `CartModule`. */
export const CART_CHECKOUT_FACADE = Symbol('CART_CHECKOUT_FACADE');
