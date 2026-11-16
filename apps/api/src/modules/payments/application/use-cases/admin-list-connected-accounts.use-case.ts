import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PAYMENTS_CONNECTED_ACCOUNT_VIEW } from '../../contracts/permissions';
import {
  listAccountPage,
  type AccountListFailure,
  type AccountListPage,
  type AdminAccountListDependencies,
} from '../admin-account-list-flow';

export type { AccountListPage, AccountListRow } from '../admin-account-list-flow';
export type { ConnectedAccountRow } from '../admin-account-flow';

type Input = Readonly<Record<string, unknown>>;

/**
 * The admin Seller accounts list (super list 22): the Market's connected accounts with tabs,
 * search, filters, sort and paging (rule `permissions [payments.connected-account.view]`).
 */
export class AdminListConnectedAccounts extends UseCase<
  Input,
  AccountListPage,
  AccountListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'payments.admin-list-connected-accounts',
    rule: { kind: 'permissions', allOf: [PAYMENTS_CONNECTED_ACCOUNT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminAccountListDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return listAccountPage(this.deps, context, input);
  }
}
