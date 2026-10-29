import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { BUYER_ACCOUNT_DELETE } from '../../contracts/permissions';
import type { AccountDeletionDependencies } from '../account-deletion-dependencies';
import {
  requestAccountDeletionForBuyer,
  type AdminDeletionRequestMade,
  type AdminRequestDeletionFailure,
} from '../admin-account-deletion-flow';

export type { AdminDeletionRequestMade };

interface Input {
  readonly accountId: unknown;
  readonly ticketRef: unknown;
  readonly reason: unknown;
  readonly confirm: unknown;
}

/**
 * `customers.admin-request-account-deletion`: an admin asks for a buyer's account to be deleted,
 * with a ticket reference and a reason (protected key `customers.buyer-account.delete` and a fresh
 * admin step-up proof, spent inside the flow). The buyer must be an active customer account of the
 * admin's Market (ownership check in the flow).
 */
export class AdminRequestAccountDeletion extends UseCase<
  Input,
  AdminDeletionRequestMade,
  AdminRequestDeletionFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.admin-request-account-deletion',
    rule: { kind: 'permissions', allOf: [BUYER_ACCOUNT_DELETE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AccountDeletionDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return requestAccountDeletionForBuyer(this.deps, context, input);
  }
}
