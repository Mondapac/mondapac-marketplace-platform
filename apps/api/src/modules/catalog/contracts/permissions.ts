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

/**
 * Read the seller's own products, Offers and revisions (catalog design 8.1). Seller scope: the
 * Seller Owner holds every seller key; the default roles that receive it are identity's seed.
 */
export const CATALOG_OWN_PRODUCT_VIEW = definePermission('catalog', {
  key: 'catalog.own-product.view',
  scope: 'seller',
  protected: false,
});

/**
 * Read the marketplace review queue and the Offers waiting in it (catalog design 8.1, 8.2). Platform
 * scope; unprotected, so Catalogue Moderator and Viewer receive it by identity's seed.
 */
export const CATALOG_PRODUCT_VIEW = definePermission('catalog', {
  key: 'catalog.product.view',
  scope: 'platform',
  protected: false,
});

/**
 * Approve an Offer's first publication or ask the seller for changes (catalog design 4.4, 8.1).
 * Platform scope; unprotected, so Catalogue Moderator receives it by identity's seed.
 */
export const CATALOG_PRODUCT_APPROVE = definePermission('catalog', {
  key: 'catalog.product.approve',
  scope: 'platform',
  protected: false,
});

/**
 * Pause and resume a published product (catalog design 4.1a, 8.1): the reversible admin hold that
 * takes the product and all its Offers off sale. Platform scope; unprotected, so Catalogue
 * Moderator receives it by identity's seed, next to `catalog.product.delete`.
 */
export const CATALOG_PRODUCT_PAUSE = definePermission('catalog', {
  key: 'catalog.product.pause',
  scope: 'platform',
  protected: false,
});

/**
 * Withdraw a SELLER product as admin (catalog design 4.1, 8.1: "Delete" on the Products page).
 * Terminal. Platform scope; unprotected, so Catalogue Moderator receives it by identity's seed.
 */
export const CATALOG_PRODUCT_DELETE = definePermission('catalog', {
  key: 'catalog.product.delete',
  scope: 'platform',
  protected: false,
});

/**
 * Retire a PLATFORM product (catalog design 4.1, CAT-48): terminal, so protected; the Platform
 * Administrator grants it in a custom role and no default role lists it.
 */
export const CATALOG_PLATFORM_PRODUCT_RETIRE = definePermission('catalog', {
  key: 'catalog.platform-product.retire',
  scope: 'platform',
  protected: true,
});

/**
 * Share a saved filter with every admin of the Market (catalog design 9.2d): "Everyone" in the
 * Save filter dialog, and the edit and delete of a filter somebody else shared. Without it an
 * admin who can see the list still saves and manages filters for themselves only. Platform scope;
 * unprotected, so Catalogue Moderator receives it by identity's seed (the Platform Administrator
 * holds every key).
 */
export const CATALOG_SAVED_FILTER_SHARE = definePermission('catalog', {
  key: 'catalog.saved-filter.share',
  scope: 'platform',
  protected: false,
});

export const CATALOG_PERMISSIONS = declarePermissions('catalog', [
  CATALOG_OWN_PRODUCT_VIEW,
  CATALOG_PLATFORM_PRODUCT_EDIT,
  CATALOG_OWN_PRODUCT_EDIT,
  CATALOG_PRODUCT_VIEW,
  CATALOG_PRODUCT_APPROVE,
  CATALOG_PRODUCT_PAUSE,
  CATALOG_PRODUCT_DELETE,
  CATALOG_PLATFORM_PRODUCT_RETIRE,
  CATALOG_SAVED_FILTER_SHARE,
]);
