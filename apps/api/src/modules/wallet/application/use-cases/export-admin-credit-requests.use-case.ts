import type { CallContext } from '@mondapac/shared-kernel';
import type { ExportFile } from '../../../../platform/list-export';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { WALLET_CREDIT_VIEW } from '../../contracts/permissions';
import {
  exportAdminCredits,
  type AdminCreditListDependencies,
  type CreditExportFailure,
  type CreditExportInput,
} from '../admin-credit-list-flow';

/**
 * `wallet.export-admin-credit-requests`: the requests of the admin Credit requests list as a CSV
 * or XLSX file (the list's only bulk action; no bulk money action exists). Same key as the list.
 */
export class ExportAdminCreditRequests extends UseCase<
  CreditExportInput,
  ExportFile,
  CreditExportFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'wallet.export-admin-credit-requests',
    rule: { kind: 'permissions', allOf: [WALLET_CREDIT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminCreditListDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: CreditExportInput) {
    return exportAdminCredits(this.deps, context, input);
  }
}
