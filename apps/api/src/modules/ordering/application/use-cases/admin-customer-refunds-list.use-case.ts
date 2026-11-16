import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ListPage } from '../../../../platform/list-query';
import { ORDERING_ORDER_VIEW } from '../../contracts/permissions';
import {
  readCustomerRefunds,
  type CustomerRefundsDependencies,
  type CustomerRefundsFailure,
} from '../customer-refunds-list-flow';
import type { RefundView } from '../refund-flow';

/**
 * `ordering.admin-customer-refunds-list`: the refunds of one customer's orders as a super list
 * (state, reason and requested-between filters; sort by requested or amount; page numbers with a
 * total or Previous and Next). Customers management phase 2b. Rule: `ordering.order.view`, a
 * platform admin not acting as a seller. Ids, codes, amounts and instants only.
 */
export class AdminCustomerRefundsList extends UseCase<
  unknown,
  ListPage<RefundView>,
  CustomerRefundsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.admin-customer-refunds-list',
    rule: { kind: 'permissions', allOf: [ORDERING_ORDER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CustomerRefundsDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: unknown,
  ): Promise<Result<ListPage<RefundView>, CustomerRefundsFailure>> {
    return readCustomerRefunds(this.deps, context, input);
  }
}
