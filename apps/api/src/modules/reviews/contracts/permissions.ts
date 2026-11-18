import { declarePermissions, definePermission } from '../../../platform/authz';

// The permission catalogue of reviews (buyer reviews and ratings package 1). The switch decides
// whether the Market collects and shows reviews at all, so both keys are protected platform keys:
// only the Platform Administrator holds them by definition. A buyer's own reads and writes need
// no key (rule `own-resources`); the public reads are `anonymous`. Package 2 adds the moderation
// keys: viewing and moderating are ordinary keys a role can hold; removing is protected.

/** See the reviews state of the Market (off or active). Protected for now. */
export const REVIEWS_SETTINGS_VIEW = definePermission('reviews', {
  key: 'reviews.settings.view',
  scope: 'platform',
  protected: true,
});

/** Move the Market's reviews between off and active. */
export const REVIEWS_SETTINGS_MANAGE = definePermission('reviews', {
  key: 'reviews.settings.manage',
  scope: 'platform',
  protected: true,
});

/**
 * See the moderation queue and a review with its reports, signals and history. Not a `.view` key
 * on purpose: the Viewer role holds every unprotected `.view` key, and a held review can show a
 * buyer's phone number or address, so this key is given to a role by name.
 */
export const REVIEWS_MODERATION_QUEUE = definePermission('reviews', {
  key: 'reviews.moderation.queue',
  scope: 'platform',
  protected: false,
});

/** Publish a held review, hide or restore a review, dismiss reports (with a reason code). */
export const REVIEWS_MODERATION_MODERATE = definePermission('reviews', {
  key: 'reviews.moderation.moderate',
  scope: 'platform',
  protected: false,
});

/** Remove a review for illegal, defamatory or private content. Not reversible. */
export const REVIEWS_MODERATION_REMOVE = definePermission('reviews', {
  key: 'reviews.moderation.remove',
  scope: 'platform',
  protected: true,
});

/** See the shop's own published reviews (never the buyer's name, only the order reference). */
export const REVIEWS_SELLER_VIEW = definePermission('reviews', {
  key: 'reviews.seller.view',
  scope: 'seller',
  protected: false,
});

/** Write and edit the shop's one public reply to a review. */
export const REVIEWS_SELLER_REPLY = definePermission('reviews', {
  key: 'reviews.seller.reply',
  scope: 'seller',
  protected: false,
});

/** Report a review of the shop to the platform's moderators (never hide or remove it). */
export const REVIEWS_SELLER_REPORT = definePermission('reviews', {
  key: 'reviews.seller.report',
  scope: 'seller',
  protected: false,
});

/**
 * See one customer's reviews (with their status and moderation state), the seller ratings they
 * gave, their helpful votes and the reports by and about them, on the admin customer page
 * (customers management phase 2b). Read only; a platform admin not acting as anyone. Never a
 * seller key: a seller must not be able to tie a review to a buyer. Not seeded to the Viewer.
 */
export const REVIEWS_CUSTOMER_REVIEW_VIEW = definePermission('reviews', {
  key: 'reviews.customer-review.view',
  scope: 'platform',
  protected: false,
});

/**
 * Share a saved filter of the seller Reviews list with everyone in the store ("Everyone" in the
 * Save filter dialog), and rename, unshare or delete a filter another member shared (the generic
 * saved-filter routes of `lists`). Without it a member who can see the list still saves and manages
 * filters for themselves only. Seller scope, unprotected; the Seller Owner holds every seller key
 * by definition and no default role lists it. A filter holds no review text of a buyer, only the
 * selector (view, search words, stars, sort), so sharing it exposes nothing the list does not.
 */
export const REVIEWS_SELLER_SAVED_FILTER_SHARE = definePermission('reviews', {
  key: 'reviews.seller-saved-filter.share',
  scope: 'seller',
  protected: false,
});

export const REVIEWS_PERMISSIONS = declarePermissions('reviews', [
  REVIEWS_CUSTOMER_REVIEW_VIEW,
  REVIEWS_SELLER_REPLY,
  REVIEWS_SELLER_REPORT,
  REVIEWS_SELLER_SAVED_FILTER_SHARE,
  REVIEWS_SELLER_VIEW,
  REVIEWS_MODERATION_MODERATE,
  REVIEWS_MODERATION_REMOVE,
  REVIEWS_MODERATION_QUEUE,
  REVIEWS_SETTINGS_MANAGE,
  REVIEWS_SETTINGS_VIEW,
]);
