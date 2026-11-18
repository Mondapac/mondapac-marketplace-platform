import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ACCOUNT_DELETION_REQUESTS_VIEW } from '../../contracts/permissions';
import {
  listAdminDeletionRequests,
  type AdminDeletionListDependencies,
  type AdminDeletionListFailure,
  type AdminDeletionListPage,
  type DeletionListInput,
} from '../admin-deletion-list-flow';

export type { AdminDeletionListPage };

/**
 * `customers.admin-list-account-deletions`: the Market's buyer deletion requests (the Account
 * deletion requests super list, list 25): views by status with counts, filters, sort, page
 * numbers or Previous/Next, and each row's actions. Ids, dates and who asked only.
 */
export class AdminListAccountDeletions extends UseCase<
  DeletionListInput,
  AdminDeletionListPage,
  AdminDeletionListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.admin-list-account-deletions',
    rule: { kind: 'permissions', allOf: [ACCOUNT_DELETION_REQUESTS_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminDeletionListDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: DeletionListInput) {
    return listAdminDeletionRequests(this.deps, context, input);
  }
}
