import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ORDERING_ORDER_VIEW } from '../../contracts/permissions';
import {
  createSavedFilter,
  type SavedFilterCreateFailure,
} from '../saved-views/saved-view-operations';
import type { SavedFilterView, SavedViewDependencies } from '../saved-views/saved-view-shared';

/**
 * `ordering.admin-saved-filter-create`: Saves the tab, filters and sort of the admin order list under a name, for the caller (`me`) or for every admin (`everyone`, which also needs `ordering.saved-filter.share`, else `access.denied` and nothing is written). One account keeps at most 50 filters in a list and a list has at most 20 shared; a name is one per owner and, among shared filters, one per list, whatever its case. A filter shared with everyone is audited (ids and codes only).
 */
export class AdminSavedFilterCreate extends UseCase<
  unknown,
  SavedFilterView,
  SavedFilterCreateFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.admin-saved-filter-create',
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
  ): Promise<Result<SavedFilterView, SavedFilterCreateFailure>> {
    return createSavedFilter(this.deps, 'admin', context, input);
  }
}
