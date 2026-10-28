import { declarePermissions, definePermission } from '../../../platform/authz';

// The permission catalogue of promotions (promotions package T1). Keys are three segments with the
// module first (platform-foundations 6.1), so the plan's `promotions.manage`, `promotions.view`
// and `seller.promotions.manage` are `promotions.promotion.manage`, `promotions.promotion.view`
// and `promotions.own-promotion.manage`. The Market switch is protected like reviews' and wallet's:
// only the Platform Administrator holds it by definition.

/** Create, edit, pause and set the budget of platform promotions; pause any promotion; review queue. Protected: it moves platform money. */
export const PROMOTIONS_PROMOTION_MANAGE = definePermission('promotions', {
  key: 'promotions.promotion.manage',
  scope: 'platform',
  protected: true,
});

/**
 * See the promotions list with usage counts only: no cost, budget or share fields (a Viewer sees
 * no financial data; owner decision of 28 October). Not protected, so a read-only role may hold it.
 */
export const PROMOTIONS_PROMOTION_VIEW = definePermission('promotions', {
  key: 'promotions.promotion.view',
  scope: 'platform',
  protected: false,
});

/** Create, edit, pause and resume the seller's own promotions; opt in to co-funded campaigns. */
export const PROMOTIONS_OWN_PROMOTION_MANAGE = definePermission('promotions', {
  key: 'promotions.own-promotion.manage',
  scope: 'seller',
  protected: false,
});

/** See the promotions state of the Market (off or active). Protected. */
export const PROMOTIONS_SETTINGS_VIEW = definePermission('promotions', {
  key: 'promotions.settings.view',
  scope: 'platform',
  protected: true,
});

/** Move the Market's promotions between off and active. Protected. */
export const PROMOTIONS_SETTINGS_MANAGE = definePermission('promotions', {
  key: 'promotions.settings.manage',
  scope: 'platform',
  protected: true,
});

export const PROMOTIONS_PERMISSIONS = declarePermissions('promotions', [
  PROMOTIONS_OWN_PROMOTION_MANAGE,
  PROMOTIONS_PROMOTION_MANAGE,
  PROMOTIONS_PROMOTION_VIEW,
  PROMOTIONS_SETTINGS_MANAGE,
  PROMOTIONS_SETTINGS_VIEW,
]);
