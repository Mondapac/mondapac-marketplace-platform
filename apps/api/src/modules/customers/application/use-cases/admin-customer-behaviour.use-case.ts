import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CUSTOMERS_CUSTOMER_VIEW } from '../../contracts/permissions';
import { behaviourAnswer } from '../customer-activity-sections';
import {
  readSectionItem,
  type CustomerSectionDependencies,
  type CustomerSectionFailure,
} from '../customer-section-lists';
import { ENGAGEMENT_CUSTOMER_BEHAVIOUR_VIEW } from '../section-keys';

/**
 * `customers.admin-customer-behaviour`: a customer's personalization switch and behaviour summary (view counts, the most viewed categories; never the search text), from engagement's facade (phase 2b). Rule: `customers.customers.view` and `engagement.customer-behaviour.view`.
 */
export class AdminCustomerBehaviourSection extends UseCase<
  unknown,
  unknown,
  CustomerSectionFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.admin-customer-behaviour',
    rule: {
      kind: 'permissions',
      allOf: [CUSTOMERS_CUSTOMER_VIEW.key, ENGAGEMENT_CUSTOMER_BEHAVIOUR_VIEW],
    },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CustomerSectionDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: unknown,
  ): Promise<Result<unknown, CustomerSectionFailure>> {
    return readSectionItem(
      this.deps,
      context,
      input,
      (peers, accountId) => peers.behaviour.adminCustomerBehaviour(context, accountId),
      behaviourAnswer,
    );
  }
}
