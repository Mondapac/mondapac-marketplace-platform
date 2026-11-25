import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../../platform/authz';
import type { DiscountTotals } from '../../domain/discount-cost';
import type { InstantWindow } from '../../domain/period';

/**
 * What the discount cost reads of promotions (dashboards v2, phase 2): the totals of the orders
 * whose payment was confirmed in a window, in one currency, under the caller's own context (the
 * owner checks its key again). Totals only; no order or promotion comes back.
 */
export interface DiscountSources {
  totalsOf(
    context: CallContext,
    currency: string,
    window: InstantWindow,
  ): Promise<Result<DiscountTotals, AccessDenied | { readonly code: 'access.unavailable' }>>;
}

export const DISCOUNT_SOURCES = Symbol('reporting.DiscountSources');
