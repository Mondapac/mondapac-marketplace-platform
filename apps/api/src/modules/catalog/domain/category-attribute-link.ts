import { err, ok } from '@mondapac/shared-kernel';
import type { Id, MarketId, Result, Temporal } from '@mondapac/shared-kernel';

const CODE = /^[a-z][a-z0-9_-]{0,63}$/;

/** The most filterable attributes one category may list itself (the database CHECK says the same). */
export const CATEGORY_FILTERS_MAX = 20;

/**
 * The data types a buyer can filter by (attributes plan, decision ت۸): choices, yes/no and
 * numbers. Brand and number-with-unit join when those types are seeded (packages A5 and A3).
 */
export const FILTERABLE_DATA_TYPES: readonly string[] = [
  'select',
  'multi-select',
  'boolean',
  'integer',
  'decimal',
];

export interface CategoryAttributeLinkState {
  readonly marketId: MarketId;
  readonly categoryId: Id<'Category'>;
  /** The feature set this category holds, or null: it takes its parent's. */
  readonly familyId: Id<'AttributeFamily'> | null;
  /** Filterable attribute codes in the order a buyer sees them; children add to these. */
  readonly filters: readonly string[];
  readonly revisionId: Id<'CategoryAttributeLinkRevision'>;
  readonly revisionNo: number;
  readonly version: number;
  /** When the link was first made. */
  readonly createdAt: Temporal.Instant;
  /** When the current revision was made (the root's creation for the first). */
  readonly revisedAt: Temporal.Instant;
}

export type CategoryAttributeLinkRefusal =
  | { readonly code: 'category-links.filter-invalid'; readonly index: number }
  | { readonly code: 'category-links.filter-repeated'; readonly index: number }
  | { readonly code: 'category-links.too-many-filters' };

function check(filters: readonly string[]): CategoryAttributeLinkRefusal | null {
  if (filters.length > CATEGORY_FILTERS_MAX) return { code: 'category-links.too-many-filters' };
  const seen = new Set<string>();
  for (const [index, code] of filters.entries()) {
    if (!CODE.test(code)) return { code: 'category-links.filter-invalid', index };
    if (seen.has(code)) return { code: 'category-links.filter-repeated', index };
    seen.add(code);
  }
  return null;
}

/**
 * A category's feature set and ordered filter list (attributes plan, package A4; categories C8).
 * A null feature set means "inherited from the parent". That the feature set is active and that
 * every filter is an active, filterable definition is checked by the use case, which reads them.
 */
export class CategoryAttributeLink {
  readonly #state: CategoryAttributeLinkState;

  private constructor(state: CategoryAttributeLinkState) {
    this.#state = Object.freeze(state);
  }

  static create(input: {
    readonly marketId: MarketId;
    readonly categoryId: Id<'Category'>;
    readonly revisionId: Id<'CategoryAttributeLinkRevision'>;
    readonly familyId: Id<'AttributeFamily'> | null;
    readonly filters: readonly string[];
    readonly now: Temporal.Instant;
  }): Result<CategoryAttributeLink, CategoryAttributeLinkRefusal> {
    const refusal = check(input.filters);
    if (refusal !== null) return err(refusal);
    return ok(
      new CategoryAttributeLink({
        marketId: input.marketId,
        categoryId: input.categoryId,
        familyId: input.familyId,
        filters: [...input.filters],
        revisionId: input.revisionId,
        revisionNo: 1,
        version: 1,
        createdAt: input.now,
        revisedAt: input.now,
      }),
    );
  }

  static rehydrate(state: CategoryAttributeLinkState): CategoryAttributeLink {
    return new CategoryAttributeLink(state);
  }

  revise(input: {
    readonly revisionId: Id<'CategoryAttributeLinkRevision'>;
    readonly familyId: Id<'AttributeFamily'> | null;
    readonly filters: readonly string[];
    readonly now: Temporal.Instant;
  }): Result<CategoryAttributeLink, CategoryAttributeLinkRefusal> {
    const refusal = check(input.filters);
    if (refusal !== null) return err(refusal);
    return ok(
      new CategoryAttributeLink({
        ...this.#state,
        revisedAt: input.now,
        familyId: input.familyId,
        filters: [...input.filters],
        revisionId: input.revisionId,
        revisionNo: this.#state.revisionNo + 1,
        version: this.#state.version + 1,
      }),
    );
  }

  get state(): CategoryAttributeLinkState {
    return this.#state;
  }
}

/** One link as the resolution reads it. */
export interface LinkFact {
  readonly familyId: Id<'AttributeFamily'> | null;
  readonly filters: readonly string[];
}

export interface EffectiveFilter {
  readonly code: string;
  /** The category that lists it: itself or the nearest ancestor that does. */
  readonly fromCategoryId: string;
}

export interface EffectiveAttributes {
  /** The feature set in force and the category that holds it; null when nobody up the chain does. */
  readonly familyId: Id<'AttributeFamily'> | null;
  readonly familyFromCategoryId: string | null;
  /** Ancestors first, each ancestor's order kept, a code once (its highest listing wins). */
  readonly filters: readonly EffectiveFilter[];
}

/**
 * What a category ends up with (categories C8): the feature set of the nearest category, itself
 * first, that holds one; and the filters of every category from the root down to it, each list in
 * its own order, a code once. `chain` is the category and its ancestors, the category first.
 */
export function resolveEffective(
  chain: readonly string[],
  linkOf: (categoryId: string) => LinkFact | undefined,
): EffectiveAttributes {
  let familyId: Id<'AttributeFamily'> | null = null;
  let familyFromCategoryId: string | null = null;
  for (const id of chain) {
    const link = linkOf(id);
    if (link?.familyId !== undefined && link.familyId !== null) {
      familyId = link.familyId;
      familyFromCategoryId = id;
      break;
    }
  }
  const filters: EffectiveFilter[] = [];
  const seen = new Set<string>();
  for (const id of [...chain].reverse()) {
    for (const code of linkOf(id)?.filters ?? []) {
      if (seen.has(code)) continue;
      seen.add(code);
      filters.push({ code, fromCategoryId: id });
    }
  }
  return { familyId, familyFromCategoryId, filters };
}
