import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';

/** How many categories the summary names, the most viewed first. */
export const TOP_CATEGORIES = 10;

/** A customer's behaviour as the customer page shows it: counts and ids, never the search text. */
export interface AdminCustomerBehaviour {
  readonly personalization: {
    /** Whether behaviour is recorded and used for this customer (no row means on). */
    readonly enabled: boolean;
    /** When the customer last changed it (ISO instant); null when they never did. */
    readonly changedAt: string | null;
  };
  /** What is held: the last 12 months, or less when the customer switched personalization off. */
  readonly summary: {
    readonly productViews: number;
    readonly categoryViews: number;
    readonly cartAdditions: number;
    /** The most viewed categories, by views then id; at most {@link TOP_CATEGORIES}. */
    readonly topCategories: readonly {
      readonly categoryId: Id<'Category'>;
      readonly views: number;
    }[];
  };
}

/** One add-to-cart event the customer made. */
export interface AdminCartAddition {
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
  /** ISO instant. */
  readonly addedAt: string;
}

export interface AdminCartAdditionsRequest {
  readonly accountId: Id<'Account'>;
  /** Both optional; `from` is included, `to` excluded, and the range is cut to the 12 months kept. */
  readonly from: Temporal.Instant | null;
  readonly to: Temporal.Instant | null;
  readonly direction: 'asc' | 'desc';
  readonly window: { readonly offset: number; readonly limit: number };
  readonly withTotal: boolean;
}

export type CustomerBehaviourFailure = AccessDenied | { readonly code: 'access.unavailable' };

/**
 * The admin's reads of one customer's behaviour (customers management phase 2b). Each method is
 * one use case behind `engagement.customer-behaviour.view`, for a platform admin not acting as
 * anyone; the caller's `CallContext` is passed unchanged.
 */
export interface CustomerBehaviourFacade {
  adminCustomerBehaviour(
    context: CallContext,
    accountId: Id<'Account'>,
  ): Promise<Result<AdminCustomerBehaviour, CustomerBehaviourFailure>>;

  adminCustomerCartAdditions(
    context: CallContext,
    request: AdminCartAdditionsRequest,
  ): Promise<
    Result<
      { readonly rows: readonly AdminCartAddition[]; readonly total: number | null },
      CustomerBehaviourFailure
    >
  >;
}

export const CUSTOMER_BEHAVIOUR_FACADE = Symbol('CUSTOMER_BEHAVIOUR_FACADE');
