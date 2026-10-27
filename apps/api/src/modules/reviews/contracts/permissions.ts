import { declarePermissions, definePermission } from '../../../platform/authz';

// The permission catalogue of reviews (buyer reviews and ratings package 1). The switch decides
// whether the Market collects and shows reviews at all, so both keys are protected platform keys:
// only the Platform Administrator holds them by definition. A buyer's own reads and writes need
// no key (rule `own-resources`); the public reads are `anonymous`. Package 2 adds the moderation
// keys.

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

export const REVIEWS_PERMISSIONS = declarePermissions('reviews', [
  REVIEWS_SETTINGS_MANAGE,
  REVIEWS_SETTINGS_VIEW,
]);
