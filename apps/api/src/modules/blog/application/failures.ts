import type { Finding } from '../domain/checks';
import type { FieldProblem } from '../domain/fields';

/** The refusals of the blog's use cases. Codes, field paths and finding codes: never a value. */
export type BlogFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldProblem[] }
  /** A dependency (Market config, catalog, sellers, certification) could not answer: fail closed. */
  | { readonly code: 'blog.unavailable' }
  | { readonly code: 'blog.post-not-found' }
  | { readonly code: 'blog.post-archived' }
  /** The action does not fit where the post is in its life. */
  | { readonly code: 'blog.wrong-state' }
  | { readonly code: 'blog.slug-taken' }
  /** An admin route touched a seller's post, which only the seller (and a reviewer) change. */
  | { readonly code: 'blog.seller-owned' }
  /** The seller's blog switch is off. */
  | { readonly code: 'blog.access-off' }
  | { readonly code: 'blog.quota-used' }
  | { readonly code: 'blog.version-limit' }
  | { readonly code: 'blog.checks-failed'; readonly findings: readonly Finding[] }
  /** The approver wrote or sent the version, and the Market does not allow a self-approval. */
  | { readonly code: 'blog.self-approval-refused' }
  | { readonly code: 'second-factor.required'; readonly actionKey: string }
  | { readonly code: 'second-factor.enrolment-required'; readonly actionKey: string }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'blog.category-not-found' }
  | { readonly code: 'blog.category-slug-taken' }
  | { readonly code: 'blog.category-in-use' }
  | { readonly code: 'blog.tag-not-found' }
  | { readonly code: 'blog.tag-slug-taken' }
  | { readonly code: 'blog.tag-in-use' }
  /** Public reads: the post was on the site and is not now (410), or there is none (404). */
  | { readonly code: 'blog.gone' }
  | { readonly code: 'blog.not-found' }
  | { readonly code: 'conflict.stale' };

export const invalid = (path: string, code = 'format'): BlogFailure => ({
  code: 'validation.failed',
  fields: [{ path, code }],
});
