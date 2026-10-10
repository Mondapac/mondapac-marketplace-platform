import { declarePermissions, definePermission } from '../../../platform/authz';

// The permission catalogue of pricing (pricing design 5.1; platform-foundations 6.1). Slice 1
// declared the three seller-scope keys; slice 4 adds the two platform-scope keys of the price-hold
// review, together with identity's seed of the default roles that receive them (design 5.3): a
// platform `view` key declared before the Viewer role is seeded with it breaks identity's pinned
// seed (Sajad G4). `pricing.price-history.view` joins with VER-09, the first use case that names
// it. The seller roles that receive the seller keys (design 5.3, Q5) are identity's seed.

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

/** See the review queue and a held record with its anchor (platform scope; design 5.1). */
export const PRICING_PRICE_HOLD_VIEW = definePermission('pricing', {
  key: 'pricing.price-hold.view',
  scope: 'platform',
  protected: false,
});

/**
 * Approve or reject a held record. Protected (H4): approving a hold has money impact, so no
 * default role lists it; the Platform Administrator grants it in admin scope.
 */
export const PRICING_PRICE_HOLD_DECIDE = definePermission('pricing', {
  key: 'pricing.price-hold.decide',
  scope: 'platform',
  protected: true,
});

export const PRICING_PERMISSIONS = declarePermissions('pricing', [
  PRICING_PRICE_VIEW,
  PRICING_PRICE_EDIT,
  PRICING_COST_VIEW,
  PRICING_PRICE_HOLD_VIEW,
  PRICING_PRICE_HOLD_DECIDE,
]);
