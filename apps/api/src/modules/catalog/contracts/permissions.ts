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
 * Read brands, the brand merge queue and seller brand proposals (catalog brand package). Platform
 * scope; unprotected, so Viewer receives it by identity's seed.
 */
export const CATALOG_BRAND_READ = definePermission('catalog', {
  key: 'catalog.brand.read',
  scope: 'platform',
  protected: false,
});

/**
 * Create, edit, archive and approve brands, merge brands and decide the merge queue (catalog brand
 * package). Platform scope; unprotected, so a custom role may grant it; no default role lists it
 * yet: the Platform Administrator holds every key. Brands are public content, but the keys are not
 * `protected` (R11) because a brand edit moves no money, certification or access.
 */
export const CATALOG_BRAND_EDIT = definePermission('catalog', {
  key: 'catalog.brand.edit',
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
  CATALOG_BRAND_READ,
  CATALOG_BRAND_EDIT,
]);
