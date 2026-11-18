import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type {
  AdminCartAddition,
  AdminCartAdditionsRequest,
  CustomerBehaviourFailure,
} from '../../contracts/customer-behaviour.facade';
import { ENGAGEMENT_CUSTOMER_BEHAVIOUR_VIEW } from '../../contracts/permissions';
import { readAdminCartAdditions } from '../admin-customer-behaviour';
import type { EngagementDependencies } from '../engagement-dependencies';

type Page = { readonly rows: readonly AdminCartAddition[]; readonly total: number | null };

/**
 * `engagement.admin-customer-cart-additions`: one page of a customer's add-to-cart history (the
 * 12 months kept) for the customer page (customers management phase 2b). Rule `permissions
 * [engagement.customer-behaviour.view]`, a platform admin not acting as anyone. Facade only.
 */
export class AdminCustomerCartAdditions extends UseCase<
  AdminCartAdditionsRequest,
  Page,
  CustomerBehaviourFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'engagement.admin-customer-cart-additions',
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
    input: AdminCartAdditionsRequest,
  ): Promise<Result<Page, CustomerBehaviourFailure>> {
    return readAdminCartAdditions(this.deps, context, input);
  }
}
