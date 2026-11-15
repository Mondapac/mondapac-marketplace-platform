import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CUSTOMERS_CUSTOMER_VIEW } from '../../contracts/permissions';
import {
  listSavedFilters,
  type SavedFiltersListFailure,
  type SavedFiltersListOutput,
} from '../saved-views/saved-view-operations';
import type { SavedViewDependencies } from '../saved-views/saved-view-shared';

/**
 * `customers.admin-saved-filters-list`: The saved views of the admin Customers list that the caller can use: their own, then the ones shared with everyone, each group oldest first. Rule: `customers.customers.view`; the population is admin. A stored document that no longer reads as the list's vocabulary is left out.
 */
export class AdminSavedFiltersList extends UseCase<
  unknown,
  SavedFiltersListOutput,
  SavedFiltersListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.admin-saved-filters-list',
    rule: { kind: 'permissions', allOf: [CUSTOMERS_CUSTOMER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SavedViewDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: unknown,
  ): Promise<Result<SavedFiltersListOutput, SavedFiltersListFailure>> {
    return listSavedFilters(this.deps, 'admin', context, input);
  }
}
