import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { WALLET_CREDIT_VIEW } from '../../contracts/permissions';
import { viewCustomerHistory, type AdminCreditFailure } from '../admin-credit-flow';
import type { HistoryView } from '../customer-flow';
import type { AdminCreditDependencies } from '../wallet-dependencies';

type Input = {
  readonly customerAccountId: unknown;
  readonly limit?: unknown;
  readonly cursor?: unknown;
};

/** `wallet.view-customer-history`: one customer's wallet journal, newest first, for the admin customer page. */
export class ViewCustomerHistory extends UseCase<Input, HistoryView, AdminCreditFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'wallet.view-customer-history',
    rule: { kind: 'permissions', allOf: [WALLET_CREDIT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminCreditDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return viewCustomerHistory(this.deps, context, input);
  }
}
