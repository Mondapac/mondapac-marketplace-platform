import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { BUYER_ACCOUNT_DELETE } from '../../contracts/permissions';
import type { AccountDeletionDependencies } from '../account-deletion-dependencies';
import {
  cancelAccountDeletionForBuyer,
  type AdminCancelDeletionFailure,
} from '../admin-account-deletion-flow';

/**
 * `customers.admin-cancel-account-deletion`: an admin cancels a pending deletion request during the
 * wait (protected key `customers.buyer-account.delete`, a reason and a fresh admin step-up proof,
 * spent inside the flow).
 */
export class AdminCancelAccountDeletion extends UseCase<
  { readonly requestId: unknown; readonly reason: unknown },
  { readonly code: 'cancelled' },
  AdminCancelDeletionFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.admin-cancel-account-deletion',
    rule: { kind: 'permissions', allOf: [BUYER_ACCOUNT_DELETE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AccountDeletionDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { requestId: unknown; reason: unknown }) {
    return cancelAccountDeletionForBuyer(this.deps, context, input);
  }
}
