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
 * Import PLATFORM products from a file (catalog design 14a, 8.1; Catalogue > Products > Import).
 * Platform scope; **unprotected**: every row still goes through the use cases that need
 * `catalog.platform-product.edit`, which the Catalogue Moderator already holds, so this key adds no
 * power over what a row may contain, only the volume; the volume is bounded (5,000 rows, one running
 * import per admin, 10 starts a day) and the default start is Inactive, which the admin can undo in
 * bulk with the pause. The terminal step (retire) stays protected. Catalogue Moderator receives it
 * by identity's seed.
 */
export const CATALOG_PLATFORM_IMPORT_RUN = definePermission('catalog', {
  key: 'catalog.platform-import.run',
  scope: 'platform',
  protected: false,
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

/**
 * Read business activities (catalog business-activity package; ADR-0040). Platform scope;
 * unprotected, so a custom role may grant it; no default role lists it yet: the Platform
 * Administrator holds every key.
 */
export const CATALOG_BUSINESS_ACTIVITY_READ = definePermission('catalog', {
  key: 'catalog.business-activity.read',
  scope: 'platform',
  protected: false,
});

/**
 * Create and edit business activities, their names and the category branches they reach. Platform
 * scope; unprotected: a definition moves no money and no certification, and the scope it gives a
 * seller is enforced by a later package that is itself access-checked.
 */
export const CATALOG_BUSINESS_ACTIVITY_EDIT = definePermission('catalog', {
  key: 'catalog.business-activity.edit',
  scope: 'platform',
  protected: false,
});

/**
 * Read the platform category tree, its details, counts, history and the impact of a change
 * (categories package C1; plan section 11). Platform scope; unprotected, so Catalogue Moderator,
 * Operations Support and Viewer receive it by identity's seed. No step-up.
 */
export const CATALOG_CATEGORY_TREE_VIEW = definePermission('catalog', {
  key: 'catalog.category-tree.view',
  scope: 'platform',
  protected: false,
});

/**
 * Add, edit, reorder, hide and show categories and change a URL name (plan section 11). Declared
 * with C1 so the page can say what the caller may do; its use cases arrive with C3. Platform scope;
 * unprotected, so Catalogue Moderator receives it by identity's seed.
 */
export const CATALOG_CATEGORY_TREE_EDIT = definePermission('catalog', {
  key: 'catalog.category-tree.edit',
  scope: 'platform',
  protected: false,
});

/**
 * Move, merge and archive categories and move products in bulk (plan section 11). A mistake here
 * can take sellers' certification badges off for a while, so the key is protected: the Platform
 * Administrator grants it in a custom role and no default role lists it. Declared with C1; its
 * use cases arrive with C4.
 */
export const CATALOG_CATEGORY_TREE_RESTRUCTURE = definePermission('catalog', {
  key: 'catalog.category-tree.restructure',
  scope: 'platform',
  protected: true,
});

/**
 * Import and export the category tree from a file (plan section 11). Protected: an import is a
 * bulk write. Declared with C1; its use cases arrive with C7. No default role lists it.
 */
export const CATALOG_CATEGORY_TREE_IMPORT = definePermission('catalog', {
  key: 'catalog.category-tree.import',
  scope: 'platform',
  protected: true,
});

/**
 * Read attributes, feature sets (attribute families), their product counts, where each attribute
 * is used and its revision history (attributes plan 14, package A1). Platform scope; unprotected,
 * so Catalogue Moderator, Operations and Viewer receive it by identity's seed.
 */
export const CATALOG_ATTRIBUTE_VIEW = definePermission('catalog', {
  key: 'catalog.attribute.view',
  scope: 'platform',
  protected: false,
});

/**
 * Add, edit and publish attributes and their values, edit feature sets and turn `material` on
 * (catalog design 8.1; attributes plan 14). Platform scope; **protected**: an attribute names what
 * a seller must declare and which changes recheck certificates, so no default role lists it and
 * the Platform Administrator grants it in a custom role. Package A1 declares it so the read-only
 * screen can tell a viewer from an editor; its use cases arrive with package A2.
 */
export const CATALOG_ATTRIBUTE_EDIT = definePermission('catalog', {
  key: 'catalog.attribute.edit',
  scope: 'platform',
  protected: true,
});

/**
 * Merge values, merge, convert or archive an attribute, each after its impact dialog (attributes
 * plan 14, package A8). Platform scope; **protected**, like `catalog.attribute.edit`: these
 * changes reach every product that uses the attribute, so no default role lists it and the
 * Platform Administrator grants it in a custom role. Archiving a `material` attribute also needs
 * a second administrator who holds this key.
 */
export const CATALOG_ATTRIBUTE_RESTRUCTURE = definePermission('catalog', {
  key: 'catalog.attribute.restructure',
  scope: 'platform',
  protected: true,
});

/**
 * Approve, map or reject a seller's suggestion of a new value for a select attribute (attributes
 * plan 14, package A5). Platform scope; unprotected, so Catalogue Moderator receives it by
 * identity's seed. It does not need `catalog.attribute.edit` (protected): approving adds exactly
 * one value to a published attribute that is not `material`, and the use case refuses any other
 * change. A brand proposal is decided with `catalog.brand.edit`, as before.
 */
export const CATALOG_ATTRIBUTE_SUGGESTION_DECIDE = definePermission('catalog', {
  key: 'catalog.attribute-suggestion.decide',
  scope: 'platform',
  protected: false,
});

/**
 * Read the Catalogue > Variants page (variants V6; plan section 9, decision tn1): the variant types
 * with their buyer display settings, every variant of the Market with its issues, and the export.
 * Platform scope; unprotected, so Catalogue Moderator, Operations Support and Viewer receive it by
 * identity's seed (the products-only pattern of `catalog.attribute.view`). No step-up.
 */
export const CATALOG_VARIANT_VIEW = definePermission('catalog', {
  key: 'catalog.variant.view',
  scope: 'platform',
  protected: false,
});

/**
 * Change how buyers choose a variant type (variants V6): the display style, the option order, the
 * swatch colours and the help sellers see above the variant grid. Platform scope; **protected**,
 * and the use case also needs `catalog.attribute.edit` (protected): a variant type is an attribute,
 * so a role that cannot edit attributes cannot change how one is shown. No default role lists it;
 * the Platform Administrator grants it in a custom role.
 */
export const CATALOG_VARIANT_TYPE_EDIT = definePermission('catalog', {
  key: 'catalog.variant-type.edit',
  scope: 'platform',
  protected: true,
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
  CATALOG_PLATFORM_IMPORT_RUN,
  CATALOG_SAVED_FILTER_SHARE,
  CATALOG_BRAND_READ,
  CATALOG_BRAND_EDIT,
  CATALOG_BUSINESS_ACTIVITY_READ,
  CATALOG_BUSINESS_ACTIVITY_EDIT,
  CATALOG_ATTRIBUTE_VIEW,
  CATALOG_ATTRIBUTE_EDIT,
  CATALOG_ATTRIBUTE_RESTRUCTURE,
  CATALOG_ATTRIBUTE_SUGGESTION_DECIDE,
  CATALOG_CATEGORY_TREE_VIEW,
  CATALOG_CATEGORY_TREE_EDIT,
  CATALOG_CATEGORY_TREE_RESTRUCTURE,
  CATALOG_CATEGORY_TREE_IMPORT,
  CATALOG_VARIANT_VIEW,
  CATALOG_VARIANT_TYPE_EDIT,
]);
