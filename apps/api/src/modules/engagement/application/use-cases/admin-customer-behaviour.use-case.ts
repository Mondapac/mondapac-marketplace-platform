import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type {
  AdminCustomerBehaviour as Behaviour,
  CustomerBehaviourFailure,
} from '../../contracts/customer-behaviour.facade';
import { ENGAGEMENT_CUSTOMER_BEHAVIOUR_VIEW } from '../../contracts/permissions';
import { readAdminCustomerBehaviour } from '../admin-customer-behaviour';
import type { EngagementDependencies } from '../engagement-dependencies';

/**
 * `engagement.admin-customer-behaviour`: one customer's personalization switch and behaviour
 * summary for the customer page (customers management phase 2b). Rule `permissions
 * [engagement.customer-behaviour.view]`, a platform admin not acting as anyone. Facade only.
 */
export class AdminCustomerBehaviour extends UseCase<
  { readonly accountId: Id<'Account'> },
  Behaviour,
  CustomerBehaviourFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'engagement.admin-customer-behaviour',
    rule: { kind: 'permissions', allOf: [ENGAGEMENT_CUSTOMER_BEHAVIOUR_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: EngagementDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: { readonly accountId: Id<'Account'> },
  ): Promise<Result<Behaviour, CustomerBehaviourFailure>> {
    return readAdminCustomerBehaviour(this.deps, context, input.accountId);
  }
}
