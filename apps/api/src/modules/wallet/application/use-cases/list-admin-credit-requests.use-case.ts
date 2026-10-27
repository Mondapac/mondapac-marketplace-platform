import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { WALLET_CREDIT_VIEW } from '../../contracts/permissions';
import {
  listAdminCredits,
  type AdminCreditFailure,
  type CreditListView,
} from '../admin-credit-flow';
import type { AdminCreditDependencies } from '../wallet-dependencies';

export type { CreditListView };

type Input = { readonly status?: unknown; readonly cursor?: unknown; readonly limit?: unknown };

/**
 * `wallet.list-admin-credit-requests`: Admin credit requests of the Market, newest first: pending, decided or granted at once.
 */
export class ListAdminCreditRequests extends UseCase<Input, CreditListView, AdminCreditFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'wallet.list-admin-credit-requests',
    rule: { kind: 'permissions', allOf: [WALLET_CREDIT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminCreditDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return listAdminCredits(this.deps, context, input);
  }
}
