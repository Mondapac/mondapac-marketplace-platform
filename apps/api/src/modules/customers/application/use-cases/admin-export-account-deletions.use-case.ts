import type { CallContext } from '@mondapac/shared-kernel';
import type { ExportFile } from '../../../../platform/list-export';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ACCOUNT_DELETION_REQUESTS_VIEW } from '../../contracts/permissions';
import {
  exportAdminDeletionRequests,
  type AdminDeletionListDependencies,
  type DeletionExportFailure,
  type DeletionExportInput,
} from '../admin-deletion-list-flow';

/**
 * `customers.admin-export-account-deletions`: the requests of the Account deletion requests list
 * as a CSV or XLSX file (the list's only bulk action). Same key as the list.
 */
export class AdminExportAccountDeletions extends UseCase<
  DeletionExportInput,
  ExportFile,
  DeletionExportFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.admin-export-account-deletions',
    rule: { kind: 'permissions', allOf: [ACCOUNT_DELETION_REQUESTS_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminDeletionListDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: DeletionExportInput) {
    return exportAdminDeletionRequests(this.deps, context, input);
  }
}
