// Public contracts of the promotions module (ADR-0008): the facade interface, the permission
// keys, the step-up action and the audit actions. Other modules may import only what this file
// exports, through ../index.ts.
export { PROMOTIONS_AUDIT_ACTIONS } from '../domain/audit';
export type {
  Allocation,
  AppliedPromotion,
  CalculationOutput,
  CalculationTotals,
  CodeOutcome,
  Layer,
  LineResult,
  ShippingResult,
} from '../domain/calculation/types';
export { PROMOTIONS_STATUSES, type PromotionsStatus } from '../domain/market-status';
export {
  FUNDINGS,
  PROMOTION_STATUSES,
  type Funding,
  type PromotionStatus,
} from '../domain/promotion';
export {
  PROMOTIONS_OWN_PROMOTION_MANAGE,
  PROMOTIONS_PERMISSIONS,
  PROMOTIONS_PROMOTION_MANAGE,
  PROMOTIONS_PROMOTION_VIEW,
  PROMOTIONS_SETTINGS_MANAGE,
  PROMOTIONS_SETTINGS_VIEW,
} from './permissions';
export {
  PROMOTIONS_FACADE,
  type PromotionsFacade,
  type PromotionsFacadeFailure,
  type QuoteLine,
  type QuoteRequest,
  type QuoteResult,
  type QuoteShipping,
} from './promotions.facade';
export { PROMOTIONS_PLATFORM_FUNDING_STEP_UP, PROMOTIONS_STEP_UP_ACTIONS } from './step-up';
