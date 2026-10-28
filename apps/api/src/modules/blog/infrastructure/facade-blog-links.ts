import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { CatalogFacade } from '../../catalog';
import type { CertificationFacade } from '../../certification';
import type { SellersFacade } from '../../sellers';
import type { BlogDependencyUnavailable, BlogLinks } from '../application/ports/blog-links';
import type { ProductFact } from '../domain/checks';

const UNAVAILABLE: BlogDependencyUnavailable = { code: 'blog.unavailable' };
const PRODUCT_BATCH = 200;
const TEXT_BATCH = 100;

/**
 * {@link BlogLinks} over the facades of catalog, sellers and certification, each called with the
 * request's context unchanged, so every answer is of the request's Market. A refusal, a fault or
 * a malformed id is `blog.unavailable`: the checks fail closed, never reading it as "fine".
 */
export class FacadeBlogLinks implements BlogLinks {
  constructor(
    private readonly catalog: CatalogFacade,
    private readonly sellers: SellersFacade,
    private readonly certification: CertificationFacade,
  ) {}

  async products(
    context: CallContext,
    productIds: readonly string[],
    sellerId: string | null,
  ): Promise<Result<ReadonlyMap<string, ProductFact>, BlogDependencyUnavailable>> {
    try {
      const seller = sellerId === null ? null : parseId<'Seller'>(sellerId);
      if (seller !== null && !seller.ok) return err(UNAVAILABLE);
      const ids: Id<'Product'>[] = [];
      for (const raw of productIds) {
        const parsed = parseId<'Product'>(raw);
        if (!parsed.ok) return err(UNAVAILABLE);
        ids.push(parsed.value);
      }
      const facts = new Map<string, ProductFact>();
      for (let from = 0; from < ids.length; from += PRODUCT_BATCH) {
        const answer = await this.catalog.productsForLinking(
          context,
          ids.slice(from, from + PRODUCT_BATCH),
          seller === null ? null : seller.value,
        );
        if (!answer.ok) return err(UNAVAILABLE);
        for (const [id, fact] of answer.value) facts.set(id, fact);
      }
      return ok(facts);
    } catch {
      return err(UNAVAILABLE);
    }
  }

  async sellerBlogEnabled(
    context: CallContext,
    sellerId: string,
  ): Promise<Result<boolean, BlogDependencyUnavailable>> {
    try {
      const parsed = parseId<'Seller'>(sellerId);
      if (!parsed.ok) return err(UNAVAILABLE);
      const answer = await this.sellers.blogAccessOf(context, parsed.value);
      return answer.ok ? ok(answer.value) : err(UNAVAILABLE);
    } catch {
      return err(UNAVAILABLE);
    }
  }

  async claimsFlagged(
    context: CallContext,
    texts: readonly { readonly locale: string; readonly text: string }[],
  ): Promise<Result<readonly boolean[], BlogDependencyUnavailable>> {
    try {
      const flags: boolean[] = [];
      for (let from = 0; from < texts.length; from += TEXT_BATCH) {
        const batch = texts.slice(from, from + TEXT_BATCH);
        const answer = await this.certification.matchClaimTerms(context, batch);
        if (!answer.ok || answer.value.length !== batch.length) return err(UNAVAILABLE);
        for (const matches of answer.value) flags.push(matches.length > 0);
      }
      return ok(flags);
    } catch {
      return err(UNAVAILABLE);
    }
  }
}
