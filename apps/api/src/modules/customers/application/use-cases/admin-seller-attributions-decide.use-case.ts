import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  CUSTOMERS_CUSTOMER_VIEW,
  CUSTOMERS_SELLER_ATTRIBUTIONS_MANAGE,
} from '../../contracts/permissions';
import {
  decideAttributions,
  type DecisionOutcome,
  type InvitationDependencies,
  type InvitationFailure,
} from '../seller-invitations-flow';

/**
 * `customers.admin-seller-attributions-decide`: an admin rejects attributions (the customer stops
 * being the seller's exclusive customer) or restores them, for 1 to 100 accounts at once. Each change
 * is audited and sends `customers.seller-attribution-changed.v1`. Rule `customers.customers.view`
 * and the protected `customers.seller-attributions.manage`; admin only, not in a Login as Seller
 * session.
 */
export class AdminSellerAttributionsDecide extends UseCase<
  unknown,
  { readonly results: readonly DecisionOutcome[] },
  InvitationFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.admin-seller-attributions-decide',
    rule: {
      kind: 'permissions',
      allOf: [CUSTOMERS_CUSTOMER_VIEW.key, CUSTOMERS_SELLER_ATTRIBUTIONS_MANAGE.key],
    },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: InvitationDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: unknown,
  ): Promise<Result<{ readonly results: readonly DecisionOutcome[] }, InvitationFailure>> {
    return decideAttributions(this.deps, context, input);
  }
}
