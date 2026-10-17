import { createHash } from 'node:crypto';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { OfferState } from '../../domain/offer';
import { claimQueriesFor, type ClaimFacts, type TagClaimQuery } from '../../domain/offer-tag';
import type { Product } from '../../domain/product';
import type { RevisionContent } from '../../domain/revision-content';
import type { CategoryPathsReader } from '../ports/category-paths.reader';
import type { ProductRepository } from '../ports/product.repository';
import type { ProductRevisionRepository } from '../ports/product-revision.repository';

export interface ClaimQueryBuilderDependencies {
  readonly products: ProductRepository;
  readonly revisions: ProductRevisionRepository;
  readonly categoryPaths: CategoryPathsReader;
}

/**
 * The published facts of a product with the product version they were read at. A write unit
 * compares the version with the one its ask was built on, so a revision published in between
 * makes the command ask again (Hassan M1). `productVersion` is null for an unknown product.
 */
export interface PublishedSnapshot {
  readonly facts: ClaimFacts | null;
  readonly productVersion: number | null;
}

/** SHA-256 hex of a canonical text: the stored `inputs_hash` of a tag copy (design 5.4). */
export const sha256Hex = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * `ClaimQueryBuilder` (catalog design 5.1; ADR-0028 d1): the only builder of claim queries. It
 * reads the claim facts of a product in the caller's unit and builds one query per (tag, variant)
 * from the state the use case will store, through the domain's `claimQueriesFor`; never from a
 * request body, the acting admin or an acting-as session. The facts are:
 * - the revision: the product's published revision after the change; for a product never
 *   published, the frozen submitted revision the caller names (5.1a point 1), never the working
 *   copy;
 * - the variants: each non-retired variant of that revision (a Simple product's single one);
 * - the category paths: every platform category of that revision on the live tree (merged mapped,
 *   archived dropped), never a seller category (AC 11).
 */
export class ClaimQueryBuilder {
  constructor(private readonly deps: ClaimQueryBuilderDependencies) {}

  /**
   * The facts of the product's published revision, or null when the product has none (or it
   * cannot be read, which the caller treats as unavailable).
   */
  async publishedFacts(market: MarketContext, product: Product): Promise<ClaimFacts | null> {
    const revisionId = product.state.publishedRevisionId;
    if (revisionId === null) return null;
    const revision = await this.deps.revisions.find(market, product.state.id, revisionId);
    if (revision === null) return null;
    return this.revisionFacts(market, product, revisionId, revision.content, true);
  }

  /** The facts of the product's published revision, read by product id; null as above. */
  async publishedFactsOf(
    market: MarketContext,
    productId: Id<'Product'>,
  ): Promise<ClaimFacts | null> {
    return (await this.publishedSnapshot(market, productId)).facts;
  }

  /** The published facts and the product version they were read at (in the caller's unit). */
  async publishedSnapshot(
    market: MarketContext,
    productId: Id<'Product'>,
  ): Promise<PublishedSnapshot> {
    const product = await this.deps.products.findById(market, productId);
    if (product === null) return { facts: null, productVersion: null };
    return {
      facts: await this.publishedFacts(market, product),
      productVersion: product.state.version,
    };
  }

  /**
   * The facts of a named revision's content: the frozen revision being submitted (not yet stored;
   * its id is the one the submit unit will store) or a stored one.
   */
  async revisionFacts(
    market: MarketContext,
    product: Product,
    revisionId: Id<'ProductRevision'>,
    content: RevisionContent,
    published: boolean,
  ): Promise<ClaimFacts> {
    const retired = new Set(
      product.state.variants.filter((v) => v.state === 'retired').map((v) => v.id as string),
    );
    const variantIds = [...content.variants]
      .sort((a, b) => a.position - b.position)
      .map((variant) => variant.variantId)
      .filter((id) => !retired.has(id)) as Id<'Variant'>[];
    const platformCategoryPaths = await this.deps.categoryPaths.livePaths(
      market,
      content.categoryIds,
    );
    return {
      productId: product.state.id,
      productRevisionId: revisionId,
      revisionPublished: published,
      variantIds,
      platformCategoryPaths,
    };
  }

  /**
   * The queries per type for the Offer state given (the state after the change), or null when the
   * Offer has no handling (nothing can be asked; the domain refuses the tag).
   */
  queries(
    offer: OfferState,
    facts: ClaimFacts,
    typeCodes: readonly string[],
  ): Map<string, readonly TagClaimQuery[]> | null {
    const out = new Map<string, readonly TagClaimQuery[]>();
    for (const typeCode of typeCodes) {
      const queries = claimQueriesFor(offer, facts, typeCode);
      if (queries === null) return null;
      out.set(typeCode, queries);
    }
    return out;
  }
}
