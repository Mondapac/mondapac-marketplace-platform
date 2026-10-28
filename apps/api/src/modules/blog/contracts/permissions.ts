import { declarePermissions, definePermission } from '../../../platform/authz';

// The permission catalogue of the blog (blog package 1). Reading and editing are separate from
// reviewing, so a writer cannot approve their own post; going live is protected (only the Platform
// Administrator holds it by definition), and pausing is its own key so an on-call editor can take a
// post down without being able to put one up. A seller's key is of seller scope and is held by the
// Seller Owner by definition, but it is effective only while an admin has switched the seller's
// blog access on (`sellers.blog-access.edit`): the use cases refuse otherwise.

/** See the posts of the Market, their drafts, versions and the categories and tags. */
export const BLOG_POST_READ = definePermission('blog', {
  key: 'blog.post.read',
  scope: 'platform',
  protected: false,
});

/** Create posts and change their drafts; send them for review; change an event's status. */
export const BLOG_POST_EDIT = definePermission('blog', {
  key: 'blog.post.edit',
  scope: 'platform',
  protected: false,
});

/** Run the checks, edit a post in review, approve it or send it back. Not the writer's own post. */
export const BLOG_POST_REVIEW = definePermission('blog', {
  key: 'blog.post.review',
  scope: 'platform',
  protected: false,
});

/** Make an approved post live (now or at a time), resume, archive, rename its address, feature it. */
export const BLOG_POST_PUBLISH = definePermission('blog', {
  key: 'blog.post.publish',
  scope: 'platform',
  protected: true,
});

/** Take a published post off the site at once, with a reason. */
export const BLOG_POST_PAUSE = definePermission('blog', {
  key: 'blog.post.pause',
  scope: 'platform',
  protected: false,
});

/** Create, rename and delete categories and tags. */
export const BLOG_TAXONOMY_EDIT = definePermission('blog', {
  key: 'blog.taxonomy.edit',
  scope: 'platform',
  protected: false,
});

/** A seller writes, sends and archives its own posts. Effective only while its blog switch is on. */
export const BLOG_SELLER_POST_EDIT = definePermission('blog', {
  key: 'blog.seller-post.edit',
  scope: 'seller',
  protected: false,
});

export const BLOG_PERMISSIONS = declarePermissions('blog', [
  BLOG_POST_EDIT,
  BLOG_POST_PAUSE,
  BLOG_POST_PUBLISH,
  BLOG_POST_READ,
  BLOG_POST_REVIEW,
  BLOG_SELLER_POST_EDIT,
  BLOG_TAXONOMY_EDIT,
]);
