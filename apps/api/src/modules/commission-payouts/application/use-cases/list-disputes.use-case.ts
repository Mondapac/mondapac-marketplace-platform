import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { COMMISSION_PAYOUTS_DISPUTE_VIEW } from '../../contracts/permissions';
import {
  listAdminDisputes,
  type AdminDisputeListDependencies,
  type AdminDisputeListPage,
  type AdminDisputeRow,
  type DisputeListFailure,
  type DisputeListInput,
} from '../admin-dispute-list-flow';
import type { DisputeRowView, MoneyView } from '../dispute-flow';

export type { AdminDisputeListPage, AdminDisputeRow, DisputeRowView, MoneyView };

/**
 * `commission-payouts.list-disputes`: an admin lists the dispute cases of the Market (the Disputes
 * super list, list 23): views by bucket with counts, search, filters, sort, page numbers or
 * Previous/Next, and each row's actions.
 */
export class ListDisputes extends UseCase<
  DisputeListInput,
  AdminDisputeListPage,
  DisputeListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.list-disputes',
    rule: { kind: 'permissions', allOf: [COMMISSION_PAYOUTS_DISPUTE_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminDisputeListDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: DisputeListInput) {
    return listAdminDisputes(this.deps, context, input);
  }
}
