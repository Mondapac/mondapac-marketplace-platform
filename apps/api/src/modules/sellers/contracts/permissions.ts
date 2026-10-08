import { declarePermissions, definePermission } from '../../../platform/authz';

// The permission catalogue of sellers (sellers design 6.1; platform-foundations 6.1). Keys join
// slice by slice, each with the first use case that names it.

/**
 * Complete details, submit and submit again; request a change of business identity (design 6.1).
 * Seller scope, protected: no custom role can hold it while protected seller keys are not
 * grantable (R11 narrowing, Ali ID 8.5), so only the Seller Owner system role, which holds every
 * key of its scope, has it. No default role lists it.
 */
export const SELLERS_BUSINESS_IDENTITY_EDIT = definePermission('sellers', {
  key: 'sellers.business-identity.edit',
  scope: 'seller',
  protected: true,
});

/**
 * Record review checks, run a re-lookup, record a manual register check (design 6.1); slice 4a
 * uses it to read the register state of a file. Platform scope, not protected; the default role
 * mapping (Onboarding and Compliance) is `identity`'s seed and is not changed here.
 */
export const SELLERS_SELLER_FILE_REVIEW = definePermission('sellers', {
  key: 'sellers.seller-file.review',
  scope: 'platform',
  protected: false,
});

export const SELLERS_PERMISSIONS = declarePermissions('sellers', [
  SELLERS_BUSINESS_IDENTITY_EDIT,
  SELLERS_SELLER_FILE_REVIEW,
]);
