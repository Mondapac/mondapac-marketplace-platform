import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_CATEGORY_TREE_VIEW } from '../../contracts/permissions';
import type {
  CategoryOfferReviewFlagsStore,
  FlaggedCategoryView,
} from '../ports/category-offer-review-flags.store';

export type ViewCategoryOfferReviewFlagsFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' };

export interface ViewCategoryOfferReviewFlagsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly categoryFlags: CategoryOfferReviewFlagsStore;
}

/**
 * `catalog.view-category-offer-review-flags` (risk-based Offer approval slice 4; owner answer 7:
 * the read here, the banner UI in slice 5): every platform category of the Market with "always
 * review" or the Offer review stop on, with each flag's change time and the flags row's version
 * (the `expectedVersion` of the next change; a category not listed has version 0 and both off).
 * Sub-categories inherit, so the list names only where a flag was set. Rule `permissions
 * [catalog.category-tree.view]`; admin population only. One read-only unit; the table is tiny.
 */
export class ViewCategoryOfferReviewFlags extends UseCase<
  Record<string, never>,
  readonly FlaggedCategoryView[],
  ViewCategoryOfferReviewFlagsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.view-category-offer-review-flags',
    rule: { kind: 'permissions', allOf: [CATALOG_CATEGORY_TREE_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ViewCategoryOfferReviewFlagsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<readonly FlaggedCategoryView[], ViewCategoryOfferReviewFlagsFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const read = await this.deps.unitOfWork.run(
      market,
      async () => ok(await this.deps.categoryFlags.listFlagged(market)),
      { readOnly: true },
    );
    return read.ok ? ok(read.value) : err({ code: 'access.unavailable' });
  }
}
