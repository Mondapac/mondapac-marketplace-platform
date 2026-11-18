import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { WALLET_CREDIT_VIEW } from '../../contracts/permissions';
import type { AdminCreditFailure } from '../admin-credit-flow';
import {
  listAdminCreditPage,
  type AdminCreditListDependencies,
  type AdminCreditListPage,
  type AdminCreditRow,
  type CreditListInput,
} from '../admin-credit-list-flow';

export type { AdminCreditListPage, AdminCreditRow };

/**
 * `wallet.list-admin-credit-requests`: an admin lists the admin credit requests of the Market (the
 * Credit requests super list, list 24): views with counts, filters, sort, page numbers or
 * Previous/Next, and each row's actions.
 */
export class ListAdminCreditRequests extends UseCase<
  CreditListInput,
  AdminCreditListPage,
  AdminCreditFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'wallet.list-admin-credit-requests',
    rule: { kind: 'permissions', allOf: [WALLET_CREDIT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminCreditListDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: CreditListInput) {
    return listAdminCreditPage(this.deps, context, input);
  }
}
