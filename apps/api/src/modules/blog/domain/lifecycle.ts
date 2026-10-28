// The lifecycle of a post and of its versions, as one table the use cases ask. A post is a row with
// a working status while no version has been live (draft, in_review, changes_requested, approved,
// scheduled) and published, unpublished or archived after. A published post keeps its live version
// and may have one open version (draft, in review, returned or approved) beside it; the open
// version's own state says where that edit is. Nothing here reads a clock or a store.

export const POST_STATUSES = [
  'draft',
  'in_review',
  'changes_requested',
  'approved',
  'scheduled',
  'published',
  'unpublished',
  'archived',
] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

export const VERSION_STATES = [
  'draft',
  'in_review',
  'returned',
  'approved',
  'live',
  'retired',
] as const;
export type VersionState = (typeof VERSION_STATES)[number];

export const POST_ACTIONS = [
  'edit',
  'submit',
  'approve',
  'request-changes',
  'reviewer-edit',
  'publish',
  'schedule',
  'unschedule',
  'pause',
  'resume',
  'archive',
  'rename-slug',
  'feature',
] as const;
export type PostAction = (typeof POST_ACTIONS)[number];

/** What the lifecycle needs to know about a post. */
export interface PostFacts {
  readonly status: PostStatus;
  /** A version is live now (`live_version_id` is set). */
  readonly hasLive: boolean;
  /** The state of the open version (the draft pointer), if any. */
  readonly open: VersionState | null;
  /** The post was live at some time (`published_at` is set). */
  readonly everPublished: boolean;
  /** An instant is set for the open version to go live (`scheduled_at`). */
  readonly scheduled: boolean;
}

export type LifecycleRefusal = 'blog.post-archived' | 'blog.wrong-state';

/** How `edit` works on a post right now. */
export type EditMode = 'in-place' | 'new-draft' | null;

/** Where an author's edit lands: the draft itself, or a new draft started from the open version. */
export function editModeOf(post: PostFacts): EditMode {
  if (post.status === 'archived') return null;
  if (post.open === 'draft') return 'in-place';
  if (post.open === null) return post.hasLive ? 'new-draft' : null;
  if (post.open === 'returned' || post.open === 'approved') return 'new-draft';
  return null;
}

/** Null when the action is allowed now, else the refusal code. */
export function refusalFor(action: PostAction, post: PostFacts): LifecycleRefusal | null {
  if (post.status === 'archived') return 'blog.post-archived';
  const wrong = 'blog.wrong-state' as const;
  switch (action) {
    case 'edit':
      return editModeOf(post) === null ? wrong : null;
    case 'submit':
      return post.open === 'draft' ? null : wrong;
    case 'approve':
    case 'request-changes':
    case 'reviewer-edit':
      return post.open === 'in_review' ? null : wrong;
    case 'publish':
    case 'schedule':
      // A paused post is resumed first, so a pause cannot be lifted by publishing around it.
      return post.open === 'approved' && post.status !== 'unpublished' ? null : wrong;
    case 'unschedule':
      return post.scheduled ? null : wrong;
    case 'pause':
      return post.status === 'published' ? null : wrong;
    case 'resume':
      return post.status === 'unpublished' ? null : wrong;
    case 'archive':
      return null;
    case 'rename-slug':
      return post.everPublished ? null : wrong;
    case 'feature':
      return post.status === 'published' ? null : wrong;
  }
}

/**
 * The working status of a post that was never live, after an action on its open version; a post
 * that has been live keeps `published` or `unpublished` (the open version's state is the edit's).
 */
export function statusAfter(
  action: 'new-draft' | 'submit' | 'approve' | 'request-changes' | 'schedule' | 'unschedule',
  post: PostFacts,
): PostStatus {
  if (post.hasLive || post.everPublished) return post.status;
  switch (action) {
    case 'new-draft':
      return 'draft';
    case 'submit':
      return 'in_review';
    case 'approve':
      return 'approved';
    case 'request-changes':
      return 'changes_requested';
    case 'schedule':
      return 'scheduled';
    case 'unschedule':
      return 'approved';
  }
}

/** The state of the open version, shown to authors and reviewers in words they know. */
export function stageOf(
  post: PostFacts,
): 'draft' | 'in-review' | 'changes-requested' | 'approved' | 'none' {
  switch (post.open) {
    case 'draft':
      return 'draft';
    case 'in_review':
      return 'in-review';
    case 'returned':
      return 'changes-requested';
    case 'approved':
      return 'approved';
    default:
      return 'none';
  }
}

/** Whether buyers can read the post now: the live version of a published post. */
export const isPublic = (post: Pick<PostFacts, 'status' | 'hasLive'>): boolean =>
  post.status === 'published' && post.hasLive;

/**
 * What a public read of a slug answers when the post is not public: `gone` (410) for a post that
 * was live and is paused or archived, `not-found` for one that never was.
 */
export function publicAbsence(
  post: Pick<PostFacts, 'status' | 'everPublished'>,
): 'gone' | 'not-found' {
  return post.everPublished && (post.status === 'unpublished' || post.status === 'archived')
    ? 'gone'
    : 'not-found';
}
