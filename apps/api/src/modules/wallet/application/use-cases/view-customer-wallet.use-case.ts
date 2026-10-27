import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { WALLET_CREDIT_VIEW } from '../../contracts/permissions';
import {
  viewCustomerWallet,
  type AdminCreditFailure,
  type CustomerWalletSummary,
} from '../admin-credit-flow';
import type { AdminCreditDependencies } from '../wallet-dependencies';

export type { CustomerWalletSummary };

type Input = { readonly customerAccountId: unknown };

/**
 * `wallet.view-customer-wallet`: A customer's wallet balance, the balance cap and the calling admin's caps, for the issuing screen.
 */
export class ViewCustomerWallet extends UseCase<Input, CustomerWalletSummary, AdminCreditFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'wallet.view-customer-wallet',
    rule: { kind: 'permissions', allOf: [WALLET_CREDIT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminCreditDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return viewCustomerWallet(this.deps, context, input);
  }
}
