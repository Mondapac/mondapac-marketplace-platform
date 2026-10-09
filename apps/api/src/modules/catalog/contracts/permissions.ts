import { declarePermissions, definePermission } from '../../../platform/authz';

// The permission catalogue of catalog (catalog design 8.1; platform-foundations 6.1). A key is
// declared with the first use case that names it, together with identity's seed of the default
// roles that receive it (a platform `view` key declared early breaks identity's pinned seed, see
// pricing/contracts/permissions.ts). Slice 6 declares the key of the platform-product writes.

/** Create, edit, submit and revert PLATFORM products (CAT-41). Not protected. */
export const CATALOG_PLATFORM_PRODUCT_EDIT = definePermission('catalog', {
  key: 'catalog.platform-product.edit',
  scope: 'platform',
  protected: false,
});

/**
 * Create and edit the seller's own products and Offers (OFR-01 to OFR-03). Seller scope: the Seller
 * Owner holds every seller key by definition; the default roles that receive it are identity's seed.
 */
export const CATALOG_OWN_PRODUCT_EDIT = definePermission('catalog', {
  key: 'catalog.own-product.edit',
  scope: 'seller',
  protected: false,
});

export const CATALOG_PERMISSIONS = declarePermissions('catalog', [
  CATALOG_PLATFORM_PRODUCT_EDIT,
  CATALOG_OWN_PRODUCT_EDIT,
]);
