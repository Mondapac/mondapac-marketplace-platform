import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CUSTOMERS_CUSTOMER_VIEW } from '../../contracts/permissions';
import { CART_REMINDERS_SECTION } from '../customer-activity-sections';
import {
  readSectionList,
  type CustomerSectionDependencies,
  type CustomerSectionFailure,
} from '../customer-section-lists';
import { NOTIFICATIONS_CUSTOMER_CART_REMINDER_VIEW } from '../section-keys';

/**
 * `customers.admin-customer-cart-reminders`: the abandoned-cart reminders a customer was sent (kept 30 days) as a super list, from notifications' facade (phase 2b). Rule: `customers.customers.view` and `notifications.customer-cart-reminder.view`.
 */
export class AdminCustomerCartRemindersSection extends UseCase<
  unknown,
  unknown,
  CustomerSectionFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.admin-customer-cart-reminders',
    rule: {
      kind: 'permissions',
      allOf: [CUSTOMERS_CUSTOMER_VIEW.key, NOTIFICATIONS_CUSTOMER_CART_REMINDER_VIEW],
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
    return readSectionList(this.deps, CART_REMINDERS_SECTION, context, input);
  }
}
