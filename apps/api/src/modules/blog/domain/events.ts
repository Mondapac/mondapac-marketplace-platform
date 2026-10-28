import { defineEvent, eventField } from '@mondapac/shared-kernel';
import type { EventDefinition } from '@mondapac/shared-kernel';
import { OWNER_TYPES, POST_KINDS } from './content';

// The events of the blog, written to its outbox in the unit of the change. Ids and enums only: no
// title, note or text. Notifications to authors and reviewers are not built in this package (no
// consumer yet); the events carry what a consumer needs: the post, the version, who owns it.

const PAYLOAD = {
  postId: eventField.id(),
  versionId: eventField.id(),
  kind: eventField.enumOf(POST_KINDS),
  ownerType: eventField.enumOf(OWNER_TYPES),
  /** The owning seller of a seller's post. */
  sellerId: eventField.optional(eventField.id()),
};

/** A draft was sent for review. Consumer to come: mail to the reviewers. */
export const BlogPostSubmitted = defineEvent({
  type: 'blog.post-submitted.v1',
  aggregateType: 'blog-post',
  payload: PAYLOAD,
});

/** A reviewer approved a version. Consumer to come: mail to the author. */
export const BlogPostApproved = defineEvent({
  type: 'blog.post-approved.v1',
  aggregateType: 'blog-post',
  payload: PAYLOAD,
});

/** A reviewer sent a version back with a note. Consumer to come: mail to the author. */
export const BlogPostChangesRequested = defineEvent({
  type: 'blog.post-changes-requested.v1',
  aggregateType: 'blog-post',
  payload: PAYLOAD,
});

/** A reviewer changed the text of a version in review. Consumer to come: mail to the author. */
export const BlogPostEditedByReviewer = defineEvent({
  type: 'blog.post-edited-by-reviewer.v1',
  aggregateType: 'blog-post',
  payload: PAYLOAD,
});

/** A version went live. Consumer to come: mail to the author; search and sitemap later. */
export const BlogPostPublished = defineEvent({
  type: 'blog.post-published.v1',
  aggregateType: 'blog-post',
  payload: PAYLOAD,
});

/** A live post was taken off the site. */
export const BlogPostPaused = defineEvent({
  type: 'blog.post-paused.v1',
  aggregateType: 'blog-post',
  payload: PAYLOAD,
});

/** A paused post is live again. */
export const BlogPostResumed = defineEvent({
  type: 'blog.post-resumed.v1',
  aggregateType: 'blog-post',
  payload: PAYLOAD,
});

/** A post was archived. */
export const BlogPostArchived = defineEvent({
  type: 'blog.post-archived.v1',
  aggregateType: 'blog-post',
  payload: PAYLOAD,
});

export const BLOG_EVENTS: readonly EventDefinition[] = [
  BlogPostSubmitted,
  BlogPostApproved,
  BlogPostChangesRequested,
  BlogPostEditedByReviewer,
  BlogPostPublished,
  BlogPostPaused,
  BlogPostResumed,
  BlogPostArchived,
];
