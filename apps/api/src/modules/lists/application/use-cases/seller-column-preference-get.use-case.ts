import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type {
  ColumnPreferenceDependencies,
  ColumnPreferenceFailure,
  ColumnPreferenceView,
} from '../column-preference-shared';
import { handleColumnPreferenceGet } from './column-preference-get.use-case';

/**
 * `lists.seller-column-preference-get`: the column use case for a seller list: the same checks of the list's view key, run for
 * the `seller` population. The caller must be a seller session with a store; an acting-as session
 * is refused. A store-scoped list keeps the choice per member and store, an account-scoped list per
 * account. Open to a seller whose store is not yet approved, like the other seller list routes.
 */
export class SellerColumnPreferenceGet extends UseCase<
  { readonly listKey?: unknown },
  ColumnPreferenceView,
  ColumnPreferenceFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'lists.seller-column-preference-get',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ColumnPreferenceDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: { readonly listKey?: unknown },
  ): Promise<Result<ColumnPreferenceView, ColumnPreferenceFailure>> {
    return handleColumnPreferenceGet('seller', this.deps, context, input);
  }
}
