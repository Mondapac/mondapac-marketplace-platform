import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PAYMENTS_CONNECTED_ACCOUNT_VIEW } from '../../contracts/permissions';
import {
  listConnectedAccounts,
  type AdminAccountFailure,
  type ConnectedAccountPage,
} from '../admin-account-flow';
import type { PaymentsDependencies } from '../payments-dependencies';

export type { ConnectedAccountPage, ConnectedAccountRow } from '../admin-account-flow';

/** The Market's connected accounts, newest first (rule `permissions [payments.connected-account.view]`). */
export class AdminListConnectedAccounts extends UseCase<
  { readonly status?: unknown; readonly cursor?: unknown },
  ConnectedAccountPage,
  AdminAccountFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'payments.admin-list-connected-accounts',
    rule: { kind: 'permissions', allOf: [PAYMENTS_CONNECTED_ACCOUNT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PaymentsDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: { readonly status?: unknown; readonly cursor?: unknown },
  ) {
    return listConnectedAccounts(this.deps, context, input);
  }
}
