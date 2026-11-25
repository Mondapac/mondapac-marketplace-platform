import type { CallContext, Result, Temporal } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { DiscountCostTotals } from '../domain/discount-cost';

export {
  DISCOUNT_COST_KINDS,
  type DiscountCostAmounts,
  type DiscountCostByKind,
  type DiscountCostKind,
  type DiscountCostTotals,
} from '../domain/discount-cost';

/** The longest window one discount-cost read covers: 13 months of Market days, with a margin. */
export const MAX_DISCOUNT_COST_WINDOW_DAYS = 400;

export interface DiscountCostRequest {
  /** Payment confirmations in `[from, to)`: the instants of the Market days asked. */
  readonly window: { readonly from: Temporal.Instant; readonly to: Temporal.Instant };
  /** ISO 4217; the Market's currency. A redemption in another currency is not counted. */
  readonly currency: string;
}

export type DiscountCostFailure =
  | AccessDenied
  | { readonly code: 'validation.failed' }
  | { readonly code: 'promotions.unavailable' };

/**
 * What `reporting` reads of promotions for the dashboards (dashboards v2, phase 2). Each method
 * is one use case with its own rule; the caller's `CallContext` passes through unchanged.
 */
export interface PromotionsReportingFacade {
  /**
   * The discount cost of the orders paid in the window (`promotions.sum-discount-cost`): keys
   * `commission-payouts.settlement.view` and `promotions.promotion.manage`, a platform admin
   * acting as themselves. One read-only unit.
   */
  discountCost(
    context: CallContext,
    request: DiscountCostRequest,
  ): Promise<Result<DiscountCostTotals, DiscountCostFailure>>;
}

/**
 * Nest token of the {@link PromotionsReportingFacade}, provided and exported by
 * `PromotionsModule`.
 */
export const PROMOTIONS_REPORTING_FACADE = Symbol('PROMOTIONS_REPORTING_FACADE');
