import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PAYMENTS_CONNECTED_ACCOUNT_VIEW } from '../../contracts/permissions';
import {
  viewConnectedAccount,
  type AdminAccountFailure,
  type ConnectedAccountDetail,
} from '../admin-account-flow';
import type { PaymentsDependencies } from '../payments-dependencies';

export type { ConnectedAccountDetail } from '../admin-account-flow';

/** One seller's connected account and its latest bank changes (rule `permissions [payments.connected-account.view]`). */
export class AdminViewConnectedAccount extends UseCase<
  { readonly sellerId?: unknown },
  ConnectedAccountDetail,
  AdminAccountFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'payments.admin-view-connected-account',
    rule: { kind: 'permissions', allOf: [PAYMENTS_CONNECTED_ACCOUNT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PaymentsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly sellerId?: unknown }) {
    return viewConnectedAccount(this.deps, context, input);
  }
}
