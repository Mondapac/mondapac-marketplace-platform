import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { WALLET_CREDIT_ISSUE } from '../../contracts/permissions';
import {
  issueAdminCredit,
  type AdminCreditFailure,
  type AdminCreditView,
  type IssueAdminCreditInput,
} from '../admin-credit-flow';
import type { AdminCreditDependencies } from '../wallet-dependencies';

export type { AdminCreditView };

type Input = IssueAdminCreditInput;

/**
 * `wallet.issue-admin-credit`: Issues promo store credit to a customer (admin; protected key; step-up `wallet.credit.issue`):
 * granted at once within the Market's per-issue and daily caps, else a pending request for a
 * second admin. Refused in acting-as; audited; idempotent by key.
 */
export class IssueAdminCredit extends UseCase<Input, AdminCreditView, AdminCreditFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'wallet.issue-admin-credit',
    rule: { kind: 'permissions', allOf: [WALLET_CREDIT_ISSUE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminCreditDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return issueAdminCredit(this.deps, context, input);
  }
}
