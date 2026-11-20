// The words the admin blog screens share (statuses, kinds, paths, permission keys). The list's own
// row and answer types are in `list/posts-list-types.ts`. Titles are what an editor typed:
// rendered as plain text only.

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

export const POST_KINDS = ['product', 'brand', 'event', 'news'] as const;
export type PostKind = (typeof POST_KINDS)[number];

export const OWNER_TYPES = ['platform', 'seller'] as const;
export type OwnerType = (typeof OWNER_TYPES)[number];

export const BLOG_EDIT_PERMISSION = 'blog.post.edit';
export const BLOG_REVIEW_PERMISSION = 'blog.post.review';
export const API_BLOG_TAXONOMY = 'blog/admin/taxonomy';
export const NEW_POST_PATH = '/content/blog/new';
export const postPath = (id: string): string => `/content/blog/${id}`;
export const BLOG_TAXONOMY_PERMISSION = 'blog.taxonomy.edit';
export const TAXONOMY_PATH = '/content/blog/taxonomy';
export const BLOG_PUBLISH_PERMISSION = 'blog.post.publish';
export const BLOG_PAUSE_PERMISSION = 'blog.post.pause';

/** The blog media library: the upload key, the list and upload route, and a picture's rendition. */
export const BLOG_MEDIA_EDIT_PERMISSION = 'blog.media.edit';
export const API_BLOG_MEDIA = 'blog/admin/media';
export const mediaUrl = (id: string, size: 'thumb' | 'large'): string =>
  `/api/${API_BLOG_MEDIA}/${id}/${size}`;
