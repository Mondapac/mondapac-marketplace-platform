import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  viewAccountDeletionAvailability,
  type AccountDeletionAvailability,
} from '../account-deletion-settings-flow';
import type { CustomersDependencies } from '../customers-dependencies';

/** `customers.view-account-deletion-availability`: the customer reads whether they may delete their account (rule `own-resources`). */
export class ViewAccountDeletionAvailability extends UseCase<
  Record<string, never>,
  AccountDeletionAvailability,
  never
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.view-account-deletion-availability',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CustomersDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return viewAccountDeletionAvailability(this.deps, context);
  }
}
