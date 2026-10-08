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

export const SELLERS_PERMISSIONS = declarePermissions('sellers', [SELLERS_BUSINESS_IDENTITY_EDIT]);
