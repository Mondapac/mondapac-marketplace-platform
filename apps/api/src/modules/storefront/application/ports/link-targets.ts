import type { CallContext } from '@mondapac/shared-kernel';

/** A live platform category, as the public tree answers it. */
export interface LiveCategoryRow {
  readonly id: string;
  readonly parentId: string | null;
  readonly slug: string;
}

/**
 * What the slider needs to know about the targets other modules own (categories, products,
 * sellers), asked only through their facades with the request's `CallContext`, so every answer
 * is of the request's Market. Each method answers null when the owner cannot answer (a fault):
 * the caller then drops what depends on it, never guesses.
 */
export interface LinkTargets {
  /** The live category tree of the request's Market. */
  categories(context: CallContext): Promise<readonly LiveCategoryRow[] | null>;
  /** The store address of each of these sellers that may sell now (a suspended one is absent). */
  sellerSlugs(
    context: CallContext,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, string> | null>;
}

export const LINK_TARGETS = Symbol('STOREFRONT_LINK_TARGETS');
