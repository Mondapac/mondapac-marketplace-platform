import { auditField, defineAuditAction } from '@mondapac/shared-kernel';
import { MODULE_KEYS } from './modules';
import { LINKED_TYPES, TEMPLATES } from './templates';

// The audited actions of the storefront, registered at boot with
// `registerAuditActions('storefront', STOREFRONT_AUDIT_ACTIONS)`. Ids, enums and whole numbers
// only: no title, slug, text or link of the content is written to the audit.

/** The audit target type of a storefront page (the navigation is the system page `navigation`). */
export const STOREFRONT_PAGE_TARGET = 'storefront.page';

const TEMPLATE = auditField.enumOf([...TEMPLATES.keys()] as [string, ...string[]]);
const MODULE = auditField.enumOf(MODULE_KEYS);
const OPERATION = auditField.enumOf([
  'add',
  'update',
  'remove',
  'reorder',
  'restore',
  'replace',
] as const);

/** An admin created a dynamic page, or a system page's row was created by its first edit. */
export const StorefrontPageCreated = defineAuditAction({
  action: 'storefront.page.create',
  targetType: STOREFRONT_PAGE_TARGET,
  actors: ['authenticated'],
  after: {
    template: TEMPLATE,
    linkedType: auditField.optional(
      auditField.enumOf(LINKED_TYPES as ['category', 'product', 'seller']),
    ),
  },
});

/** An admin changed a page's settings (title, slug, SEO, linked entity, live window). */
export const StorefrontPageUpdated = defineAuditAction({
  action: 'storefront.page.update',
  targetType: STOREFRONT_PAGE_TARGET,
  actors: ['authenticated'],
  after: { slugChanged: auditField.boolean(), windowSet: auditField.boolean() },
});

/** An admin changed a page's draft; `placementCount` is the draft's module count after it. */
export const StorefrontDraftChanged = defineAuditAction({
  action: 'storefront.draft.change',
  targetType: STOREFRONT_PAGE_TARGET,
  actors: ['authenticated'],
  after: {
    operation: OPERATION,
    module: auditField.optional(MODULE),
    versionNo: auditField.integer(),
    placementCount: auditField.integer(),
  },
});

/** A platform admin published a page's draft (or approved the navigation draft). */
export const StorefrontPagePublished = defineAuditAction({
  action: 'storefront.page.publish',
  targetType: STOREFRONT_PAGE_TARGET,
  actors: ['authenticated'],
  after: {
    versionNo: auditField.integer(),
    placementCount: auditField.integer(),
    navigation: auditField.boolean(),
  },
});

/** A platform admin archived a dynamic page; `redirected` says its URL now sends buyers on. */
export const StorefrontPageArchived = defineAuditAction({
  action: 'storefront.page.archive',
  targetType: STOREFRONT_PAGE_TARGET,
  actors: ['authenticated'],
  after: { redirected: auditField.boolean() },
});

export const STOREFRONT_AUDIT_ACTIONS = [
  StorefrontPageCreated,
  StorefrontPageUpdated,
  StorefrontDraftChanged,
  StorefrontPagePublished,
  StorefrontPageArchived,
] as const;
