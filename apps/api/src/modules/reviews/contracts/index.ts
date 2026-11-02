// Public contracts of the reviews module (ADR-0008): the facade interface, the permission keys
// and the audit actions. Other modules may import only what this file exports, through
// ../index.ts.
export { REVIEWS_AUDIT_ACTIONS } from '../domain/audit';
export { REVIEWS_STATUSES, type ReviewsStatus } from '../domain/market-status';
export {
  REVIEW_STATUSES,
  SELLER_RATING_REASONS,
  type ReviewStatus,
  type SellerRatingReason,
} from '../domain/rules';
export {
  REVIEWS_MODERATION_MODERATE,
  REVIEWS_MODERATION_REMOVE,
  REVIEWS_MODERATION_QUEUE,
  REVIEWS_PERMISSIONS,
  REVIEWS_SETTINGS_MANAGE,
  REVIEWS_SETTINGS_VIEW,
} from './permissions';
export { REVIEWS_STEP_UP_ACTIONS } from './step-up';
export {
  MAX_RATING_TOTALS_PAGE,
  REVIEWS_FACADE,
  type ProductRatingSummary,
  type ProductRatingTotal,
  type ProductRatingTotalsPage,
  type ReviewsFacade,
  type ReviewsFacadeFailure,
  type SellerRatingSummary,
} from './reviews.facade';
