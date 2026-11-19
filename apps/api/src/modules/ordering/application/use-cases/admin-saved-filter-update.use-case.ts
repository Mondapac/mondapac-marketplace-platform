import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ORDERING_ORDER_VIEW } from '../../contracts/permissions';
import {
  updateSavedFilter,
  type SavedFilterUpdateFailure,
} from '../saved-views/saved-view-operations';
import type { SavedFilterView, SavedViewDependencies } from '../saved-views/saved-view-shared';

/**
 * `ordering.admin-saved-filter-update`: Renames a saved filter of the admin order list and sets who can use it (both given). The owner may always; any admin with `ordering.saved-filter.share` may also change a filter shared with everyone; making a filter `everyone` needs that key for anybody. Another admin's `me` filter is `saved-filter.not-found`. Changes to or from `everyone` are audited.
 */
export class AdminSavedFilterUpdate extends UseCase<
  unknown,
  SavedFilterView,
  SavedFilterUpdateFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.admin-saved-filter-update',
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
  ): Promise<Result<SavedFilterView, SavedFilterUpdateFailure>> {
    return updateSavedFilter(this.deps, 'admin', context, input);
  }
}
