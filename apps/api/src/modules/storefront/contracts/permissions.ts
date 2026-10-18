import { declarePermissions, definePermission } from '../../../platform/authz';

// The permission catalogue of the storefront (content-management analysis 7; john 17 Oct). A
// content editor reads pages, edits drafts and creates dynamic pages; what buyers see changes
// only when a platform admin publishes a page, archives one or approves the navigation, so those
// three keys are protected (only the Platform Administrator holds them by definition). No
// default role holds any key yet, so the role seed is unchanged: a platform admin gives the
// editor keys to a custom role (for example "Storefront content editor").

/** See the storefront pages, their drafts and versions, and the navigation draft. */
export const STOREFRONT_PAGE_READ = definePermission('storefront', {
  key: 'storefront.page.read',
  scope: 'platform',
  protected: false,
});

/** Change a page's draft (its modules) and its settings. */
export const STOREFRONT_PAGE_EDIT = definePermission('storefront', {
  key: 'storefront.page.edit',
  scope: 'platform',
  protected: false,
});

/** Create a dynamic page from a template. */
export const STOREFRONT_PAGE_CREATE = definePermission('storefront', {
  key: 'storefront.page.create',
  scope: 'platform',
  protected: false,
});

/** Publish a page's draft, so buyers see it. */
export const STOREFRONT_PAGE_PUBLISH = definePermission('storefront', {
  key: 'storefront.page.publish',
  scope: 'platform',
  protected: true,
});

/** Archive a dynamic page (it stops being served; its URL may send buyers elsewhere). */
export const STOREFRONT_PAGE_ARCHIVE = definePermission('storefront', {
  key: 'storefront.page.archive',
  scope: 'platform',
  protected: true,
});

/** Change the navigation draft: the left-rail items and the Browse drawer's categories. */
export const STOREFRONT_NAVIGATION_EDIT = definePermission('storefront', {
  key: 'storefront.navigation.edit',
  scope: 'platform',
  protected: false,
});

/** Approve the navigation draft, so buyers see it. Separate from publishing pages. */
export const STOREFRONT_NAVIGATION_APPROVE = definePermission('storefront', {
  key: 'storefront.navigation.approve',
  scope: 'platform',
  protected: true,
});

export const STOREFRONT_PERMISSIONS = declarePermissions('storefront', [
  STOREFRONT_PAGE_READ,
  STOREFRONT_PAGE_EDIT,
  STOREFRONT_PAGE_CREATE,
  STOREFRONT_PAGE_PUBLISH,
  STOREFRONT_PAGE_ARCHIVE,
  STOREFRONT_NAVIGATION_EDIT,
  STOREFRONT_NAVIGATION_APPROVE,
]);
