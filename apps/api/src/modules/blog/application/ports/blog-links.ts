import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { ProductFact } from '../../domain/checks';

/** An answer that could not be had. There is no partial answer; the checks fail closed. */
export interface BlogDependencyUnavailable {
  readonly code: 'blog.unavailable';
}

/**
 * What other modules say that the automatic checks and the seller rules need: which linked
 * products are on sale and which the seller sells (catalog), whether a seller has blog access
 * (sellers) and which texts make a certification claim (certification). Each answer is read
 * outside any unit of work; a fault or refusal is `blog.unavailable`.
 */
export interface BlogLinks {
  products(
    context: CallContext,
    productIds: readonly string[],
    sellerId: string | null,
  ): Promise<Result<ReadonlyMap<string, ProductFact>, BlogDependencyUnavailable>>;

  /** Whether the seller's blog switch is on. */
  sellerBlogEnabled(
    context: CallContext,
    sellerId: string,
  ): Promise<Result<boolean, BlogDependencyUnavailable>>;

  /** One flag per text, in order: true when a certification claim term occurs in it. */
  claimsFlagged(
    context: CallContext,
    texts: readonly { readonly locale: string; readonly text: string }[],
  ): Promise<Result<readonly boolean[], BlogDependencyUnavailable>>;
}

export const BLOG_LINKS = Symbol('BLOG_LINKS');
