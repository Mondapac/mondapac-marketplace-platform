import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AccountDeletionDependencies } from '../account-deletion-dependencies';
import { cancelAccountDeletion, type CancelAccountDeletionFailure } from '../account-deletion-flow';
import type { AccountDeletionCancelReason } from '../../domain/events';

/** `customers.cancel-account-deletion`: the buyer cancels their pending request (rule `own-resources`, customers only). */
export class CancelAccountDeletion extends UseCase<
  { readonly reason: AccountDeletionCancelReason },
  { readonly code: 'cancelled' },
  CancelAccountDeletionFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.cancel-account-deletion',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AccountDeletionDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly reason: AccountDeletionCancelReason }) {
    return cancelAccountDeletion(this.deps, context, input.reason);
  }
}
