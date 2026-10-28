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

/**
 * The seller list and the seller page with clear fields only (design 6.1; Hassan M4): store name,
 * slug, status, area code, time zone, kind of the pending submission and dates. No decryption.
 * Platform scope, not protected. The default role mapping is `identity`'s seed: the Viewer role
 * holds it since seed version 2 (slice 6) and the Platform Administrator system role holds every
 * key; Onboarding and Compliance, Catalogue Moderator, Operations and Support and Finance get it
 * since their seed versions 3, 3, 2 and 2 (identity). The per-row `status` of the
 * list also needs `identity.seller-access.view`.
 */
export const SELLERS_SELLER_VIEW = definePermission('sellers', {
  key: 'sellers.seller.view',
  scope: 'platform',
  protected: false,
});

/**
 * Every read that decrypts business data: the review page (`review.read`), the seller page's
 * details and `reviewerBusinessDetails` (design 6.1; Hassan M4). Each such read is audited in the
 * same unit as `sellers.business-details.viewed`. Platform scope, not protected. The gate of a
 * use case has no "any of", so the approve keys do not imply it in code: the default role mapping
 * (`identity`'s seed) puts it beside `identity.seller-access.approve`, and a seed contract test
 * checks that every default role holding one holds the other.
 */
export const SELLERS_BUSINESS_DETAILS_VIEW = definePermission('sellers', {
  key: 'sellers.business-details.view',
  scope: 'platform',
  protected: false,
});

/**
 * Read and set the store settings that are not business identity: today the optional minimum
 * order (design 6.1, 18 decision 5; slice 20). Seller scope, not protected (default Store
 * Manager; the Seller Owner holds every seller key). It blocks checkout for that seller, so it
 * has its own key (least privilege). Approved sellers only. This build reads the settings under
 * the same key; the profile texts and images have their own pair, `sellers.store-profile.view`
 * and `.edit` (slice 12 part 2).
 */
export const SELLERS_STORE_SETTINGS_EDIT = definePermission('sellers', {
  key: 'sellers.store-settings.edit',
  scope: 'seller',
  protected: false,
});

/**
 * Read the public store profile: the About text, the logo and the banner (design 6.1, 6.2
 * `my-store-profile.read`; slice 12 part 2). Seller scope, not protected; the Seller Owner holds
 * every seller key. Approved sellers only. The default role mapping (Store Manager, Customer
 * Service) is `identity`'s seed.
 */
export const SELLERS_STORE_PROFILE_VIEW = definePermission('sellers', {
  key: 'sellers.store-profile.view',
  scope: 'seller',
  protected: false,
});

/**
 * Save the About text and set, replace or remove the logo and the banner (design 6.1, 6.2
 * `my-store-profile.save`; slice 12 part 2). Seller scope, not protected; every save is public at
 * once (design 3.7), so the key is separate from the read. Approved sellers only.
 */
export const SELLERS_STORE_PROFILE_EDIT = definePermission('sellers', {
  key: 'sellers.store-profile.edit',
  scope: 'seller',
  protected: false,
});

/**
 * Switch a seller's blog access on or off (blog package 1; owner decision Q1). Platform scope and
 * protected: only the Platform Administrator system role holds it by definition, and no custom
 * role can. Turning the switch off may also take the seller's live posts off the site.
 */
export const SELLERS_BLOG_ACCESS_EDIT = definePermission('sellers', {
  key: 'sellers.blog-access.edit',
  scope: 'platform',
  protected: true,
});

export const SELLERS_PERMISSIONS = declarePermissions('sellers', [
  SELLERS_BLOG_ACCESS_EDIT,
  SELLERS_BUSINESS_DETAILS_VIEW,
  SELLERS_BUSINESS_IDENTITY_EDIT,
  SELLERS_SELLER_FILE_REVIEW,
  SELLERS_SELLER_VIEW,
  SELLERS_STORE_PROFILE_EDIT,
  SELLERS_STORE_PROFILE_VIEW,
  SELLERS_STORE_SETTINGS_EDIT,
]);
