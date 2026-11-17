import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_CATEGORY_PROPOSAL_DECIDE } from '../../contracts/permissions';
import { editorAccountOf } from '../categories/category-editor';
import type { SellerCategoryStore } from '../ports/seller-category.store';
import { shelfBodyOf, type ShelfBody } from '../seller-categories/seller-category-shared';

/**
 * `seller-category.admin-list` (categories C9a): one seller's shelves in every status, active
 * first, for the Promote and Merge dialogs. Rule: the key `catalog.category-proposal.decide`, the
 * admin population, never an acting-as session. An unknown seller answers an empty list.
 */
export class SellerCategoryAdminList extends UseCase<
  { readonly sellerId: string },
  { readonly shelves: readonly ShelfBody[] },
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' }
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.seller-category-admin-list',
    rule: { kind: 'permissions', allOf: [CATALOG_CATEGORY_PROPOSAL_DECIDE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: {
      readonly unitOfWork: UnitOfWork;
      readonly shelves: SellerCategoryStore;
    },
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: { readonly sellerId: string },
  ): Promise<
    Result<
      { readonly shelves: readonly ShelfBody[] },
      { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' }
    >
  > {
    if (editorAccountOf(context) === null) return err({ code: 'access.denied' });
    const parsed = parseId<'Seller'>(input.sellerId);
    if (!parsed.ok) return ok({ shelves: [] });
    const sellerId = parsed.value;
    const { market } = context;
    const read = await this.deps.unitOfWork.run(
      market,
      async () => ok(await this.deps.shelves.shelvesOfSeller(market, sellerId)),
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    return ok({ shelves: read.value.map(shelfBodyOf) });
  }
}
