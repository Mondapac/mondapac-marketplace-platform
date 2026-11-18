import type { CallContext, Id, Money, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';

/** One line of a customer's current cart as the admin sees it: ids, quantity, the price when added. */
export interface AdminCartLine {
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
  readonly quantity: number;
  /** The price when the line was added or last changed; never the price now. */
  readonly priceAtAdd: Money;
  readonly addedAt: string;
}

/** A customer's current (active) cart, or null when they have none. */
export interface AdminCustomerCart {
  readonly cart: {
    readonly createdAt: string;
    readonly lastChangedAt: string;
    readonly lines: readonly AdminCartLine[];
  } | null;
  /** How many sell units the customer saved for later (the list itself pages on its own). */
  readonly savedCount: number;
}

/** One saved-for-later item. */
export interface AdminSavedItem {
  readonly savedItemId: Id<'SavedItem'>;
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
  readonly savedAt: string;
}

export interface AdminSavedItemsRequest {
  readonly accountId: Id<'Account'>;
  readonly direction: 'asc' | 'desc';
  readonly window: { readonly offset: number; readonly limit: number };
  readonly withTotal: boolean;
}

export type CartAdminFailure = AccessDenied | { readonly code: 'access.unavailable' };

/**
 * The admin's reads of one customer's cart for the customer page (customers management phase 2b).
 * Rule `permissions [cart.customer-cart.view]` and a platform admin not acting as anyone. Ids
 * only: the panel names the offers through catalog.
 */
export interface CartAdminFacade {
  adminCustomerCart(
    context: CallContext,
    accountId: Id<'Account'>,
  ): Promise<Result<AdminCustomerCart, CartAdminFailure>>;

  /** One page of the customer's saved-for-later list (at most 100 items), newest first by default. */
  adminCustomerSavedItems(
    context: CallContext,
    request: AdminSavedItemsRequest,
  ): Promise<
    Result<
      { readonly rows: readonly AdminSavedItem[]; readonly total: number | null },
      CartAdminFailure
    >
  >;
}

/** Nest token of the {@link CartAdminFacade}, provided and exported by `CartModule`. */
export const CART_ADMIN_FACADE = Symbol('CART_ADMIN_FACADE');
