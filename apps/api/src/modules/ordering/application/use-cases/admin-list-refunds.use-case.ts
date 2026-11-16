import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ORDERING_ORDER_VIEW } from '../../contracts/permissions';
import type { RefundListPage } from '../../domain/admin-refund-list';
import {
  listRefunds,
  type AdminRefundListDependencies,
  type RefundListInput,
} from '../admin-refund-list-flow';
import type { ReadFailure } from '../read-flow';

/**
 * The Market's refunds, one row per refund, for the admin Refunds list (rule `permissions
 * [ordering.order.view]`: a refund is part of the order an admin can already open). Read only.
 */
export class AdminListRefunds extends UseCase<RefundListInput, RefundListPage, ReadFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.admin-list-refunds',
    rule: { kind: 'permissions', allOf: [ORDERING_ORDER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminRefundListDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: RefundListInput) {
    return listRefunds(this.deps, context, input);
  }
}
