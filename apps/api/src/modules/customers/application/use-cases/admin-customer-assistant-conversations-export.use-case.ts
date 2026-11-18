import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CUSTOMERS_CUSTOMER_EXPORT, CUSTOMERS_CUSTOMER_VIEW } from '../../contracts/permissions';
import { ASSISTANT_CONVERSATIONS_SECTION } from '../customer-activity-sections';
import {
  exportSectionList,
  type CustomerSectionDependencies,
  type CustomerSectionFailure,
  type SectionExportFile,
} from '../customer-section-lists';
import { ASSISTANT_CUSTOMER_CONVERSATION_VIEW } from '../section-keys';

/**
 * `customers.admin-customer-assistant-conversations-export`: the same rows as a CSV or XLSX file (at most 10,000). Rule:
 * `customers.customers.view`, `assistant.customer-conversation.view` and the protected `customers.customers.export`, and a fresh
 * step-up proof of it. Audited (`customers.customer-section.exported`).
 */
export class AdminCustomerAssistantConversationsSectionExport extends UseCase<
  unknown,
  SectionExportFile,
  CustomerSectionFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.admin-customer-assistant-conversations-export',
    rule: {
      kind: 'permissions',
      allOf: [
        CUSTOMERS_CUSTOMER_VIEW.key,
        ASSISTANT_CUSTOMER_CONVERSATION_VIEW,
        CUSTOMERS_CUSTOMER_EXPORT.key,
      ],
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
  ): Promise<Result<SectionExportFile, CustomerSectionFailure>> {
    return exportSectionList(this.deps, ASSISTANT_CONVERSATIONS_SECTION, context, input);
  }
}
