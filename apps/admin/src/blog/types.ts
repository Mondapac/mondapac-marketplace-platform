// Answers of the admin blog post routes (apps/api blog module, read-flow.ts) and the limits the
// list screen relies on. Titles are what an editor typed: rendered as plain text only.

export const BLOG_READ_PERMISSION = 'blog.post.read';
export const BLOG_PATH = '/content/blog';
export const API_BLOG_POSTS = 'blog/admin/posts';

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
export type StatusFilter = 'all' | PostStatus;

export const POST_KINDS = ['product', 'brand', 'event', 'news'] as const;
export type PostKind = (typeof POST_KINDS)[number];
export type KindFilter = 'all' | PostKind;

export const OWNER_TYPES = ['platform', 'seller'] as const;
export type OwnerType = (typeof OWNER_TYPES)[number];
export type OwnerFilter = 'all' | OwnerType;

export interface PostRow {
  readonly id: string;
  readonly kind: PostKind;
  readonly slug: string;
  readonly ownerType: OwnerType;
  readonly sellerId: string | null;
  readonly status: PostStatus;
  /** The state of the version being worked on (draft, in_review, returned, approved), if any. */
  readonly openState: string | null;
  readonly title: string;
  readonly featured: boolean;
  readonly scheduledAt: string | null;
  readonly publishedAt: string | null;
  readonly updatedAt: string;
}

/** The API pages by number, 50 a page; `hasMore` says whether another page follows. */
export interface PostPage {
  readonly items: readonly PostRow[];
  readonly page: number;
  readonly pageSize: number;
  readonly hasMore: boolean;
}

export const BLOG_EDIT_PERMISSION = 'blog.post.edit';
export const BLOG_REVIEW_PERMISSION = 'blog.post.review';
export const API_BLOG_TAXONOMY = 'blog/admin/taxonomy';
export const NEW_POST_PATH = '/content/blog/new';
export const postPath = (id: string): string => `/content/blog/${id}`;
