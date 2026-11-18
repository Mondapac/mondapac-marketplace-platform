import type { CallContext } from '@mondapac/shared-kernel';
import type { ExportFile } from '../../../../platform/list-export';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { COMMISSION_PAYOUTS_DISPUTE_VIEW } from '../../contracts/permissions';
import {
  exportAdminDisputes,
  type AdminDisputeListDependencies,
  type DisputeExportFailure,
  type DisputeExportInput,
} from '../admin-dispute-list-flow';

/**
 * `commission-payouts.export-disputes`: the cases of the admin Disputes list as a CSV or XLSX file
 * (the list's only bulk action; no bulk money action exists). Same key as the list.
 */
export class ExportDisputes extends UseCase<DisputeExportInput, ExportFile, DisputeExportFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.export-disputes',
    rule: { kind: 'permissions', allOf: [COMMISSION_PAYOUTS_DISPUTE_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminDisputeListDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: DisputeExportInput) {
    return exportAdminDisputes(this.deps, context, input);
  }
}
