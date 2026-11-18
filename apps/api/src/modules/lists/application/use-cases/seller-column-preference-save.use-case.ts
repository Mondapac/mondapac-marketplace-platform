import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ColumnPreferenceFailure, ColumnPreferenceView } from '../column-preference-shared';
import {
  handleColumnPreferenceSave,
  type ColumnPreferenceSaveDependencies,
} from './column-preference-save.use-case';

/**
 * `lists.seller-column-preference-save`: the admin use case for a seller list: the same checks of the list's view key, run for
 * the `seller` population. The caller must be a seller session with a store; an acting-as session
 * is refused. A store-scoped list keeps the choice per member and store, an account-scoped list per
 * account. Open to a seller whose store is not yet approved, like the other seller list routes.
 */
export class SellerColumnPreferenceSave extends UseCase<
  { readonly listKey?: unknown; readonly columns?: unknown },
  ColumnPreferenceView,
  ColumnPreferenceFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'lists.seller-column-preference-save',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ColumnPreferenceSaveDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: { readonly listKey?: unknown; readonly columns?: unknown },
  ): Promise<Result<ColumnPreferenceView, ColumnPreferenceFailure>> {
    return handleColumnPreferenceSave('seller', this.deps, context, input);
  }
}
