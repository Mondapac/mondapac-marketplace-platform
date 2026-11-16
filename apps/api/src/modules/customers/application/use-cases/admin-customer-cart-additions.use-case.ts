import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CUSTOMERS_CUSTOMER_VIEW } from '../../contracts/permissions';
import { CART_ADDITIONS_SECTION } from '../customer-activity-sections';
import {
  readSectionList,
  type CustomerSectionDependencies,
  type CustomerSectionFailure,
} from '../customer-section-lists';
import { ENGAGEMENT_CUSTOMER_BEHAVIOUR_VIEW } from '../section-keys';

/**
 * `customers.admin-customer-cart-additions`: a customer's add-to-cart history (kept 12 months) as a super list, from engagement's facade (phase 2b). Rule: `customers.customers.view` and `engagement.customer-behaviour.view`.
 */
export class AdminCustomerCartAdditionsSection extends UseCase<
  unknown,
  unknown,
  CustomerSectionFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.admin-customer-cart-additions',
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
    return readSectionList(this.deps, CART_ADDITIONS_SECTION, context, input);
  }
}
