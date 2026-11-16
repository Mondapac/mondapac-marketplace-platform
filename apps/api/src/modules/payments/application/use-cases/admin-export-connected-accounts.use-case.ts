import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ExportFile } from '../../../../platform/list-export';
import { PAYMENTS_CONNECTED_ACCOUNT_VIEW } from '../../contracts/permissions';
import {
  exportAccounts,
  type AccountExportFailure,
  type AdminAccountListDependencies,
} from '../admin-account-list-flow';

type Input = Readonly<Record<string, unknown>>;

/**
 * The admin Seller accounts list as a CSV or XLSX file (super list 22): the chosen rows or what
 * the list's selector matches, at most 10,000 (rule `permissions [payments.connected-account.view]`).
 */
export class AdminExportConnectedAccounts extends UseCase<Input, ExportFile, AccountExportFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'payments.admin-export-connected-accounts',
    rule: { kind: 'permissions', allOf: [PAYMENTS_CONNECTED_ACCOUNT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminAccountListDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return exportAccounts(this.deps, context, input);
  }
}
