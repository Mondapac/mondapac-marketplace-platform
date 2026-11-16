import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ListPage } from '../../../../platform/list-query';
import { CUSTOMERS_CUSTOMER_VIEW } from '../../contracts/permissions';
import type { CustomerManagementDependencies } from '../customer-management-dependencies';
import {
  readTimeline,
  type TimelineEntryView,
  type TimelineFailure,
} from '../customer-timeline-flow';

/**
 * `customers.admin-customer-timeline`: one page of a customer's activity timeline (a super list:
 * event type and date filters, sort by time, page numbers or Previous and Next). Every read is an
 * audited open of the page (tab `activity`). Rule: `customers.customers.view`.
 */
export class AdminCustomerTimeline extends UseCase<
  unknown,
  ListPage<TimelineEntryView>,
  TimelineFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.admin-customer-timeline',
    rule: { kind: 'permissions', allOf: [CUSTOMERS_CUSTOMER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CustomerManagementDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: unknown,
  ): Promise<Result<ListPage<TimelineEntryView>, TimelineFailure>> {
    return readTimeline(this.deps, context, input);
  }
}
