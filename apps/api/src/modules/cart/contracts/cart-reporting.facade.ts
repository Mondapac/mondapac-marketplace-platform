import type { CallContext, Money, Result, Temporal } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';

/** A Market's abandoned carts at an instant: a count and a value per currency. No id. */
export interface AbandonedCartTotals {
  readonly carts: number;
  /**
   * The lines at the price when each was added or last changed (never the price now, so
   * approximate), one sum per currency, ordered by currency.
   */
  readonly values: readonly Money[];
}

export type CartReportingFailure = AccessDenied | { readonly code: 'validation.failed' };

/** The cart reads of reporting's nightly snapshot (dashboards v2, phase 2). System actor only. */
export interface CartReportingFacade {
  /**
   * The Market's ACTIVE carts, guest and account, that hold a line, carry no order mark and were
   * last changed at or before `changedAtOrBefore`, with their approximate value. Counts only.
   */
  abandonedCarts(
    context: CallContext,
    request: { readonly changedAtOrBefore: Temporal.Instant },
  ): Promise<Result<AbandonedCartTotals, CartReportingFailure>>;
}

/** Nest token of the {@link CartReportingFacade}, provided and exported by `CartModule`. */
export const CART_REPORTING_FACADE = Symbol('CART_REPORTING_FACADE');
