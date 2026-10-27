import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AccountDeletionDependencies } from '../account-deletion-dependencies';
import {
  requestAccountDeletion,
  type AccountDeletionRequestView,
  type RequestAccountDeletionFailure,
} from '../account-deletion-flow';

export type { AccountDeletionRequestView };

/** `customers.request-account-deletion`: the buyer asks to delete their own account (rule `own-resources`, customers only). */
export class RequestAccountDeletion extends UseCase<
  { readonly confirm: unknown },
  AccountDeletionRequestView,
  RequestAccountDeletionFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.request-account-deletion',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AccountDeletionDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly confirm: unknown }) {
    return requestAccountDeletion(this.deps, context, input);
  }
}
