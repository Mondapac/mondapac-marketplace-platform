import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { WALLET_CREDIT_APPROVE } from '../../contracts/permissions';
import {
  rejectAdminCredit,
  type AdminCreditFailure,
  type AdminCreditView,
} from '../admin-credit-flow';
import type { AdminCreditDependencies } from '../wallet-dependencies';

type Input = { readonly requestId: unknown; readonly reasonCode: unknown };

/**
 * `wallet.reject-admin-credit`: A second, different admin rejects a pending credit request with a closed reason (step-up
 * `wallet.credit.approve`). No money moves.
 */
export class RejectAdminCredit extends UseCase<Input, AdminCreditView, AdminCreditFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'wallet.reject-admin-credit',
    rule: { kind: 'permissions', allOf: [WALLET_CREDIT_APPROVE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminCreditDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return rejectAdminCredit(this.deps, context, input);
  }
}
