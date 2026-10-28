import { auditField, defineAuditAction } from '@mondapac/shared-kernel';
import { EVENT_STATUSES } from './event-details';
import { OWNER_TYPES, POST_KINDS } from './content';

// The audited actions of the blog, registered at boot with
// `registerAuditActions('blog', BLOG_AUDIT_ACTIONS)`. Ids, enums, whole numbers and instants only:
// no title, text, note, slug or URL of a post is ever written to the audit.

export const BLOG_POST_TARGET = 'blog.post';
export const BLOG_CATEGORY_TARGET = 'blog.category';
export const BLOG_TAG_TARGET = 'blog.tag';

const KIND = auditField.enumOf(POST_KINDS);
const OWNER = auditField.enumOf(OWNER_TYPES);
const EDIT_OPERATION = auditField.enumOf(['update', 'new-draft', 'reviewer-edit'] as const);
const EVENT_STATUS = auditField.enumOf(EVENT_STATUSES);
const PAUSE_CAUSE = auditField.enumOf(['editor', 'seller-switch-off'] as const);

/** A post was created (a draft); `copied` says it was started from a post of another Market. */
export const BlogPostCreated = defineAuditAction({
  action: 'blog.post.create',
  targetType: BLOG_POST_TARGET,
  actors: ['authenticated'],
  after: { kind: KIND, ownerType: OWNER, copied: auditField.boolean() },
});

/** A draft was saved, a new draft was started from an approved or live version, or a reviewer edited. */
export const BlogPostDraftSaved = defineAuditAction({
  action: 'blog.post.save-draft',
  targetType: BLOG_POST_TARGET,
  actors: ['authenticated'],
  after: { operation: EDIT_OPERATION, versionNo: auditField.integer() },
});

/** A draft was sent for review. `quotaUsed` is true when it used a unit of the seller's month. */
export const BlogPostSubmitted = defineAuditAction({
  action: 'blog.post.submit',
  targetType: BLOG_POST_TARGET,
  actors: ['authenticated'],
  after: { versionNo: auditField.integer(), quotaUsed: auditField.boolean() },
});

/**
 * A reviewer approved a version. `selfApproved`: the approver also wrote or sent it (a Market with
 * one admin, after a fresh step-up, whose verification time is recorded).
 */
export const BlogPostApproved = defineAuditAction({
  action: 'blog.post.approve',
  targetType: BLOG_POST_TARGET,
  actors: ['authenticated'],
  after: {
    versionNo: auditField.integer(),
    selfApproved: auditField.boolean(),
    stepUpVerifiedAt: auditField.optional(auditField.instant()),
  },
});

/** A reviewer sent a version back with a note. */
export const BlogPostChangesRequested = defineAuditAction({
  action: 'blog.post.request-changes',
  targetType: BLOG_POST_TARGET,
  actors: ['authenticated'],
  after: { versionNo: auditField.integer() },
});

/** An approved version went live, by an admin or (system) by the worker at its scheduled time. */
export const BlogPostPublished = defineAuditAction({
  action: 'blog.post.publish',
  targetType: BLOG_POST_TARGET,
  actors: ['authenticated', 'system'],
  after: { versionNo: auditField.integer(), scheduled: auditField.boolean() },
});

/** An approved version was scheduled to go live at an instant, or the schedule was removed. */
export const BlogPostScheduled = defineAuditAction({
  action: 'blog.post.schedule',
  targetType: BLOG_POST_TARGET,
  actors: ['authenticated'],
  before: { scheduledAt: auditField.optional(auditField.instant()) },
  after: {
    versionNo: auditField.integer(),
    scheduledAt: auditField.optional(auditField.instant()),
  },
});

/** A live post was taken off the site, by an editor or (system) because its seller lost blog access. */
export const BlogPostPaused = defineAuditAction({
  action: 'blog.post.pause',
  targetType: BLOG_POST_TARGET,
  actors: ['authenticated', 'system'],
  after: { cause: PAUSE_CAUSE },
});

/** A paused post is live again. */
export const BlogPostResumed = defineAuditAction({
  action: 'blog.post.resume',
  targetType: BLOG_POST_TARGET,
  actors: ['authenticated'],
  after: { versionNo: auditField.integer() },
});

/** A post was archived; `wasLive` says it had been on the site (its address now answers 410). */
export const BlogPostArchived = defineAuditAction({
  action: 'blog.post.archive',
  targetType: BLOG_POST_TARGET,
  actors: ['authenticated'],
  after: { wasLive: auditField.boolean() },
});

/** The slug of a published post changed; `redirected` says its old address now redirects. */
export const BlogPostSlugChanged = defineAuditAction({
  action: 'blog.post.rename-slug',
  targetType: BLOG_POST_TARGET,
  actors: ['authenticated'],
  after: { redirected: auditField.boolean() },
});

/** A post was made the featured one of the Market, or stopped being it. */
export const BlogPostFeatured = defineAuditAction({
  action: 'blog.post.feature',
  targetType: BLOG_POST_TARGET,
  actors: ['authenticated'],
  before: { featured: auditField.boolean() },
  after: { featured: auditField.boolean() },
});

/** The status of an event changed on the live post at once, with no review. */
export const BlogPostEventStatusChanged = defineAuditAction({
  action: 'blog.post.change-event-status',
  targetType: BLOG_POST_TARGET,
  actors: ['authenticated'],
  before: { eventStatus: EVENT_STATUS },
  after: { eventStatus: EVENT_STATUS, messageSet: auditField.boolean() },
});

export const BlogCategorySaved = defineAuditAction({
  action: 'blog.category.save',
  targetType: BLOG_CATEGORY_TARGET,
  actors: ['authenticated'],
  after: { created: auditField.boolean(), localeCount: auditField.integer() },
});

export const BlogCategoryDeleted = defineAuditAction({
  action: 'blog.category.delete',
  targetType: BLOG_CATEGORY_TARGET,
  actors: ['authenticated'],
  after: { deleted: auditField.boolean() },
});

export const BlogTagSaved = defineAuditAction({
  action: 'blog.tag.save',
  targetType: BLOG_TAG_TARGET,
  actors: ['authenticated'],
  after: { created: auditField.boolean() },
});

export const BlogTagDeleted = defineAuditAction({
  action: 'blog.tag.delete',
  targetType: BLOG_TAG_TARGET,
  actors: ['authenticated'],
  after: { deleted: auditField.boolean() },
});

export const BLOG_AUDIT_ACTIONS = [
  BlogPostCreated,
  BlogPostDraftSaved,
  BlogPostSubmitted,
  BlogPostApproved,
  BlogPostChangesRequested,
  BlogPostPublished,
  BlogPostScheduled,
  BlogPostPaused,
  BlogPostResumed,
  BlogPostArchived,
  BlogPostSlugChanged,
  BlogPostFeatured,
  BlogPostEventStatusChanged,
  BlogCategorySaved,
  BlogCategoryDeleted,
  BlogTagSaved,
  BlogTagDeleted,
] as const;
