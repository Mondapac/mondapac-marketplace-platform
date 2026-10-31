import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ACCOUNT_DELETION_REQUESTS_VIEW } from '../../contracts/permissions';
import type { AccountDeletionDependencies } from '../account-deletion-dependencies';
import {
  listPendingDeletionRequests,
  type AdminListDeletionFailure,
  type PendingDeletionRequestPage,
} from '../admin-account-deletion-flow';

export type { PendingDeletionRequestPage };

interface Input {
  readonly status?: unknown;
  readonly cursor?: unknown;
  readonly limit?: unknown;
}

/** `customers.admin-list-account-deletions`: the Market's pending deletion requests (plain view key). */
export class AdminListAccountDeletions extends UseCase<
  Input,
  PendingDeletionRequestPage,
  AdminListDeletionFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.admin-list-account-deletions',
    rule: { kind: 'permissions', allOf: [ACCOUNT_DELETION_REQUESTS_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AccountDeletionDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return listPendingDeletionRequests(this.deps, context, input);
  }
}
