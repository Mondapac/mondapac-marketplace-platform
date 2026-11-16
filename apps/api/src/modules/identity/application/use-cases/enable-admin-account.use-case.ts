import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ADMIN_ACCOUNT_DISABLE } from '../../contracts/permissions';
import {
  changeAccountStatus,
  type AccountStatusFailure,
  type AdminEnableDependencies,
  type AccountStatusInput,
  type AccountStatusOutput,
} from '../accounts/account-status';

/** The answer of an admin's disable or enable, with the review request (null for a disable). */
export type AdminStatusOutput = AccountStatusOutput;

/**
 * Enables a disabled admin account again (identity design 3.1 `disabled` → `active`, decided by
 * Ali 14.1-8; slice 8b). Rule `permissions [identity.admin-account.disable]`, with the guards of
 * a disable except the last holder: not oneself, R1, R3. Serializable (HF8). The account signs
 * in again; nothing it lost at the disable comes back. The enabling opens a review in Admin Inbox
 * › System requests (area people) in the same unit, with the admin's `note`; a reviewer's reject
 * disables the account again (people-reverters.ts).
 */
export class EnableAdminAccount extends UseCase<
  AccountStatusInput,
  AccountStatusOutput,
  AccountStatusFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.enable-admin-account',
    rule: { kind: 'permissions', allOf: [ADMIN_ACCOUNT_DISABLE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminEnableDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: AccountStatusInput,
  ): Promise<Result<AccountStatusOutput, AccountStatusFailure>> {
    return changeAccountStatus(this.deps, context, input, {
      population: 'admin',
      to: 'active',
      ruleKey: ADMIN_ACCOUNT_DISABLE.key,
      review: this.deps.review,
    });
  }
}
