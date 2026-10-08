import { declarePermissions, definePermission } from '../../../platform/authz';

// The permission catalogue of pricing (pricing design 5.1; platform-foundations 6.1). Slice 1,
// part 3b declares the three seller-scope keys: `pricing.price.edit` is named by the first use
// case (`pricing.set-regular-price`), and the Seller Owner holds every seller key by definition
// (design 5.3, Q11). The three platform-scope keys of 5.1 (`pricing.price-hold.view`,
// `pricing.price-hold.decide`, `pricing.price-history.view`) join with the first use case that
// names them (slice 4, and VER-09 for history), together with identity's seed of the default
// roles that receive them (design 5.3, 16): a platform `view` key declared before the Viewer role
// is seeded with it breaks identity's pinned seed (Sajad G4). The default seller roles that
// receive these keys (design 5.3, Q5) are identity's seed, not this file.

/** See the regular price, special price and hold status of the seller's own Offers. */
export const PRICING_PRICE_VIEW = definePermission('pricing', {
  key: 'pricing.price.view',
  scope: 'seller',
  protected: false,
});

/** Set the regular price; set or withdraw a special price (design 5.2). */
export const PRICING_PRICE_EDIT = definePermission('pricing', {
  key: 'pricing.price.edit',
  scope: 'seller',
  protected: false,
});

/**
 * See Cost. Not protected: protected seller keys are ungrantable under the identity Phase 2
 * narrowing (ID 5.4 R11), and Q11 lets the Seller Owner grant it to other roles. No default role
 * holds it; the Seller Owner does by definition (design 5.1, 5.3).
 */
export const PRICING_COST_VIEW = definePermission('pricing', {
  key: 'pricing.cost.view',
  scope: 'seller',
  protected: false,
});

export const PRICING_PERMISSIONS = declarePermissions('pricing', [
  PRICING_PRICE_VIEW,
  PRICING_PRICE_EDIT,
  PRICING_COST_VIEW,
]);
