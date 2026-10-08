import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CUSTOMER_ACCOUNT_DISABLE } from '../../contracts/permissions';
import {
  changeAccountStatus,
  type AccountStatusDependencies,
  type AccountStatusFailure,
  type AccountStatusInput,
  type AccountStatusOutput,
} from '../accounts/account-status';

/**
 * Disables a customer account (identity design 3.1 `active` → `disabled`; AC 11, AC 18; slice
 * 8b). Rule `permissions [identity.customer-account.disable]`. Across scopes the platform
 * permission alone decides (Ali 14.1-2). One serializable unit that also revokes every session
 * of the account (see `changeAccountStatus`).
 */
export class DisableCustomerAccount extends UseCase<
  AccountStatusInput,
  AccountStatusOutput,
  AccountStatusFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.disable-customer-account',
    rule: { kind: 'permissions', allOf: [CUSTOMER_ACCOUNT_DISABLE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AccountStatusDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: AccountStatusInput,
  ): Promise<Result<AccountStatusOutput, AccountStatusFailure>> {
    return changeAccountStatus(this.deps, context, input, {
      population: 'customer',
      ruleKey: CUSTOMER_ACCOUNT_DISABLE.key,
      to: 'disabled',
    });
  }
}
