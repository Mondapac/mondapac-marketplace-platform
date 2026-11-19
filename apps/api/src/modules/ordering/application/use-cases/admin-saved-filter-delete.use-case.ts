import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ORDERING_ORDER_VIEW } from '../../contracts/permissions';
import {
  deleteSavedFilter,
  type SavedFilterDeleteFailure,
  type SavedFilterDeleteOutput,
} from '../saved-views/saved-view-operations';
import type { SavedViewDependencies } from '../saved-views/saved-view-shared';

/**
 * `ordering.admin-saved-filter-delete`: Deletes a saved filter of the admin order list for good (a preference, not a record). Who may: as for the update. Deleting a filter shared with everyone is audited.
 */
export class AdminSavedFilterDelete extends UseCase<
  unknown,
  SavedFilterDeleteOutput,
  SavedFilterDeleteFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.admin-saved-filter-delete',
    rule: { kind: 'permissions', allOf: [ORDERING_ORDER_VIEW.key] },
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
  ): Promise<Result<SavedFilterDeleteOutput, SavedFilterDeleteFailure>> {
    return deleteSavedFilter(this.deps, 'admin', context, input);
  }
}
