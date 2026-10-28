import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AccountDeletionDependencies } from '../account-deletion-dependencies';
import {
  viewCurrentAccountDeletionRequest,
  type AccountDeletionRequestView,
  type ViewAccountDeletionRequestFailure,
} from '../account-deletion-flow';

/** `customers.view-account-deletion-request`: the buyer reads their pending request (rule `own-resources`). */
export class ViewAccountDeletionRequest extends UseCase<
  Record<string, never>,
  AccountDeletionRequestView,
  ViewAccountDeletionRequestFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.view-account-deletion-request',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AccountDeletionDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return viewCurrentAccountDeletionRequest(this.deps, context);
  }
}
