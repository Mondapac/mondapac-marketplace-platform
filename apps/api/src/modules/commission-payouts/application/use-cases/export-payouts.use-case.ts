import type { CallContext } from '@mondapac/shared-kernel';
import type { ExportFile } from '../../../../platform/list-export';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { COMMISSION_PAYOUTS_PAYOUT_VIEW } from '../../contracts/permissions';
import {
  exportAdminPayouts,
  type AdminPayoutListDependencies,
  type PayoutExportFailure,
  type PayoutExportInput,
} from '../admin-payout-list-flow';

/**
 * `commission-payouts.export-payouts`: the payouts of the admin Payouts list as a CSV or XLSX file
 * (the list's only bulk action; no bulk money action exists). Same key as the list.
 */
export class ExportPayouts extends UseCase<PayoutExportInput, ExportFile, PayoutExportFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.export-payouts',
    rule: { kind: 'permissions', allOf: [COMMISSION_PAYOUTS_PAYOUT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminPayoutListDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: PayoutExportInput) {
    return exportAdminPayouts(this.deps, context, input);
  }
}
