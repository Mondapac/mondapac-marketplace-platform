import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CUSTOMERS_CUSTOMER_VIEW } from '../../contracts/permissions';
import { ASSISTANT_CONVERSATIONS_SECTION } from '../customer-activity-sections';
import {
  readSectionList,
  type CustomerSectionDependencies,
  type CustomerSectionFailure,
} from '../customer-section-lists';
import { ASSISTANT_CUSTOMER_CONVERSATION_VIEW } from '../section-keys';

/**
 * `customers.admin-customer-assistant-conversations`: the count and dates of a customer's assistant conversations as a super list (never a message), from assistant's facade (phase 2b). Rule: `customers.customers.view` and `assistant.customer-conversation.view`.
 */
export class AdminCustomerAssistantConversationsSection extends UseCase<
  unknown,
  unknown,
  CustomerSectionFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.admin-customer-assistant-conversations',
    rule: {
      kind: 'permissions',
      allOf: [CUSTOMERS_CUSTOMER_VIEW.key, ASSISTANT_CUSTOMER_CONVERSATION_VIEW],
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
    return readSectionList(this.deps, ASSISTANT_CONVERSATIONS_SECTION, context, input);
  }
}
