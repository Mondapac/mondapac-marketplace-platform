import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type {
  ColumnPreferenceDependencies,
  ColumnPreferenceFailure,
  ColumnPreferenceView,
} from '../column-preference-shared';
import { handleColumnPreferenceReset } from './column-preference-reset.use-case';

/**
 * `lists.seller-column-preference-reset`: the column use case for a seller list: the same checks of the list's view key, run for
 * the `seller` population. The caller must be a seller session with a store; an acting-as session
 * is refused. A store-scoped list keeps the choice per member and store, an account-scoped list per
 * account. Open to a seller whose store is not yet approved, like the other seller list routes.
 */
export class SellerColumnPreferenceReset extends UseCase<
  { readonly listKey?: unknown },
  ColumnPreferenceView,
  ColumnPreferenceFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'lists.seller-column-preference-reset',
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
    return handleColumnPreferenceReset('seller', this.deps, context, input);
  }
}
