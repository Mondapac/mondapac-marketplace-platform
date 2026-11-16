import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { COMMISSION_PAYOUTS_PAYOUT_VIEW } from '../../contracts/permissions';
import {
  listAdminPayouts,
  type AdminPayoutListDependencies,
  type AdminPayoutListPage,
  type AdminPayoutRow,
  type PayoutListInput,
} from '../admin-payout-list-flow';
import type { PayoutFailure, PayoutRowView } from '../payout-admin-flow';

export type { AdminPayoutListPage, AdminPayoutRow, PayoutRowView };

/**
 * `commission-payouts.list-payouts`: an admin lists the Market's payouts (super list 21): a view,
 * the search and filters, a sort, page numbers or Previous/Next, the view counts and each row's
 * actions. A read; it changes nothing.
 */
export class ListPayouts extends UseCase<PayoutListInput, AdminPayoutListPage, PayoutFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.list-payouts',
    rule: { kind: 'permissions', allOf: [COMMISSION_PAYOUTS_PAYOUT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminPayoutListDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: PayoutListInput) {
    return listAdminPayouts(this.deps, context, input);
  }
}
