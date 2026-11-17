import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  handleSavedFilterDelete,
  type SavedFilterDeleteDependencies,
  type SavedFilterDeleteFailure,
  type SavedFilterDeleteInput,
  type SavedFilterDeleteOutput,
} from './saved-filter-delete.use-case';

/**
 * `lists.seller-saved-filter-delete`: `saved-filter-delete` for a seller list (super list B0-1b, seller
 * side). The rules, caps, audit and permission checks are those of the admin use case, run for the
 * `seller` population: the caller must be a seller session with a store, an acting-as (Login as
 * Seller) session is refused, a store-scoped list keeps its rows per store and an account-scoped
 * one per seller account. Open to a seller whose store is not yet approved, like the seller routes
 * it replaces: the panel is usable while onboarding.
 */
export class SellerSavedFilterDelete extends UseCase<
  SavedFilterDeleteInput,
  SavedFilterDeleteOutput,
  SavedFilterDeleteFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'lists.seller-saved-filter-delete',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SavedFilterDeleteDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: SavedFilterDeleteInput,
  ): Promise<Result<SavedFilterDeleteOutput, SavedFilterDeleteFailure>> {
    return handleSavedFilterDelete('seller', this.deps, context, input);
  }
}
