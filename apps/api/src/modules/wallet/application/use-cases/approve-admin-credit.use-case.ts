import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { WALLET_CREDIT_APPROVE } from '../../contracts/permissions';
import {
  approveAdminCredit,
  type AdminCreditFailure,
  type AdminCreditView,
} from '../admin-credit-flow';
import type { AdminCreditDependencies } from '../wallet-dependencies';

type Input = { readonly requestId: unknown };

/**
 * `wallet.approve-admin-credit`: A second, different admin approves a pending credit request (maker-checker; step-up
 * `wallet.credit.approve`); the credit is granted in the same unit, the wallet state, the customer
 * wallet and the balance cap checked again.
 */
export class ApproveAdminCredit extends UseCase<Input, AdminCreditView, AdminCreditFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'wallet.approve-admin-credit',
    rule: { kind: 'permissions', allOf: [WALLET_CREDIT_APPROVE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminCreditDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return approveAdminCredit(this.deps, context, input);
  }
}
