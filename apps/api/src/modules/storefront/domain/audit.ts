import { auditField, defineAuditAction } from '@mondapac/shared-kernel';
import { MODULE_KEYS } from './modules';
import { POSITION_KEYS, SLIDE_SCOPES } from './slide-positions';
import { MAX_REORDER_SLIDES, SLIDE_KINDS } from './slides';
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

/** The audit target type of a storefront slide. */
export const STOREFRONT_SLIDE_TARGET = 'storefront.slide';

const SLIDE_KIND = auditField.enumOf(SLIDE_KINDS);
const SLIDE_OPERATION = auditField.enumOf(['update', 'restore'] as const);

/** An editor created a slide (a draft); `placementCount` is its first version's placements. */
export const StorefrontSlideCreated = defineAuditAction({
  action: 'storefront.slide.create',
  targetType: STOREFRONT_SLIDE_TARGET,
  actors: ['authenticated'],
  after: {
    kind: SLIDE_KIND,
    versionNo: auditField.integer(),
    placementCount: auditField.integer(),
  },
});

/** An editor changed a slide's draft, or restored an earlier version into it (a new version). */
export const StorefrontSlideDraftChanged = defineAuditAction({
  action: 'storefront.slide.draft-change',
  targetType: STOREFRONT_SLIDE_TARGET,
  actors: ['authenticated'],
  after: {
    operation: SLIDE_OPERATION,
    versionNo: auditField.integer(),
    placementCount: auditField.integer(),
  },
});

/** An editor sent a slide's draft for approval. */
export const StorefrontSlideSubmitted = defineAuditAction({
  action: 'storefront.slide.submit',
  targetType: STOREFRONT_SLIDE_TARGET,
  actors: ['authenticated'],
  after: { versionNo: auditField.integer() },
});

/** A platform admin approved a slide's draft, so it is live (or scheduled). */
export const StorefrontSlidePublished = defineAuditAction({
  action: 'storefront.slide.publish',
  targetType: STOREFRONT_SLIDE_TARGET,
  actors: ['authenticated'],
  after: {
    versionNo: auditField.integer(),
    placementCount: auditField.integer(),
    /** The approver is the person who saved the version (a one-person approval). */
    selfApproved: auditField.boolean(),
  },
});

/** An editor paused a slide: it stops being served at once, with no approval. */
export const StorefrontSlidePaused = defineAuditAction({
  action: 'storefront.slide.pause',
  targetType: STOREFRONT_SLIDE_TARGET,
  actors: ['authenticated'],
  after: { versionNo: auditField.integer() },
});

/** A platform admin resumed a paused slide. */
export const StorefrontSlideResumed = defineAuditAction({
  action: 'storefront.slide.resume',
  targetType: STOREFRONT_SLIDE_TARGET,
  actors: ['authenticated'],
  after: { versionNo: auditField.integer() },
});

/** An editor archived a slide; `wasApproved` says it had a live version that stopped being served. */
export const StorefrontSlideArchived = defineAuditAction({
  action: 'storefront.slide.archive',
  targetType: STOREFRONT_SLIDE_TARGET,
  actors: ['authenticated'],
  after: { wasApproved: auditField.boolean() },
});

/** The audit target type of the order of the live slides at one position (and scope). */
export const STOREFRONT_SLIDE_ORDER_TARGET = 'storefront.slide-order';

const ORDER_SNAPSHOT = {
  scope: auditField.enumOf(SLIDE_SCOPES),
  /** Empty for the scope `all`. */
  scopeId: auditField.optional(auditField.id()),
  /** The slide ids in the order buyers see them (pinned slides still come first). */
  order: auditField.listOf(auditField.id(), MAX_REORDER_SLIDES),
};

/**
 * An editor saved the order of the live slides at one position and scope; it took effect at
 * once, with no approval. The target is the position key.
 */
export const StorefrontSlideReordered = defineAuditAction({
  action: 'storefront.slide.reorder',
  targetType: STOREFRONT_SLIDE_ORDER_TARGET,
  targetId: auditField.enumOf(POSITION_KEYS as readonly [string, ...string[]]),
  actors: ['authenticated'],
  before: ORDER_SNAPSHOT,
  after: ORDER_SNAPSHOT,
});

export const STOREFRONT_AUDIT_ACTIONS = [
  StorefrontPageCreated,
  StorefrontPageUpdated,
  StorefrontDraftChanged,
  StorefrontPagePublished,
  StorefrontPageArchived,
  StorefrontSlideCreated,
  StorefrontSlideDraftChanged,
  StorefrontSlideSubmitted,
  StorefrontSlidePublished,
  StorefrontSlidePaused,
  StorefrontSlideResumed,
  StorefrontSlideArchived,
  StorefrontSlideReordered,
] as const;
