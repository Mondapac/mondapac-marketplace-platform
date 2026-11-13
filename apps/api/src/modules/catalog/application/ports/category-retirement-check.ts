import type { CallContext, Id, Result } from '@mondapac/shared-kernel';

/** Why the certification check refused or could not answer (plan section 13 copy). */
export type CategoryRetirementRefusal =
  | { readonly code: 'category.referenced-by-policy'; readonly typeCodes: readonly string[] }
  | { readonly code: 'category.check-unavailable' };

/**
 * Certification's view of a platform category change (request C-4; certification design 3.7,
 * 8.1; ADR-0028 d5). Bound to `certification.assertCategoriesRetirable` and
 * `.platformCategoriesRetired`; the facade opens its own unit, so no caller may hold one open.
 */
export interface CategoryRetirementCheck {
  /**
   * Before a move, merge or archive: ok, or `category.referenced-by-policy` with the type codes
   * whose relaxing policy rows name an id. A refusal of any other kind, a fault or an answer of
   * the wrong shape is `category.check-unavailable` (fail closed).
   */
  assertRetirable(
    context: CallContext,
    categoryIds: readonly Id<'Category'>[],
  ): Promise<Result<void, CategoryRetirementRefusal>>;

  /**
   * The backstop after a merge or archive committed (system actor, outside any unit): certification
   * flags the policy rows on the retired ids. A refusal or fault is `category.check-unavailable`,
   * so the handler's delivery is retried.
   */
  retired(
    context: CallContext,
    categoryIds: readonly Id<'Category'>[],
  ): Promise<Result<void, { readonly code: 'category.check-unavailable' }>>;
}

export const CATEGORY_RETIREMENT_CHECK = Symbol('CATALOG_CATEGORY_RETIREMENT_CHECK');
