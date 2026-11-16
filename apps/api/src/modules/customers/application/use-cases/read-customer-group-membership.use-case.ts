import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { CustomerManagementDependencies } from '../customer-management-dependencies';

export type GroupMembershipFailure =
  | { readonly code: 'validation.failed' }
  /** No such group in the caller's Market: the caller treats it as "not a member". */
  | { readonly code: 'customers.group-not-found' };

export interface GroupMembershipInput {
  readonly groupId: string;
  readonly accountId: string;
}

/**
 * `customers.read-customer-group-membership`: whether a customer is in one of the Market's manual
 * groups. Rule `system` (promotions asks with the Market's system actor to evaluate a group
 * condition). An archived group has no members for this answer; an unknown group is
 * `customers.group-not-found`, so the caller fails closed. Ids and a boolean only.
 */
export class ReadCustomerGroupMembership extends UseCase<
  GroupMembershipInput,
  { readonly member: boolean },
  GroupMembershipFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.read-customer-group-membership',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: Pick<CustomerManagementDependencies, 'unitOfWork' | 'groups'>,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: GroupMembershipInput,
  ): Promise<Result<{ readonly member: boolean }, GroupMembershipFailure>> {
    const groupId =
      typeof input?.groupId === 'string' ? parseId<'CustomerGroup'>(input.groupId) : null;
    const accountId =
      typeof input?.accountId === 'string' ? parseId<'Account'>(input.accountId) : null;
    if (groupId === null || !groupId.ok || accountId === null || !accountId.ok) {
      return Promise.resolve(err({ code: 'validation.failed' }));
    }
    return this.deps.unitOfWork.run<{ readonly member: boolean }, GroupMembershipFailure>(
      context.market,
      async () => {
        const answer = await this.deps.groups.isMember(
          context.market,
          groupId.value,
          accountId.value,
        );
        if (answer === null) return err({ code: 'customers.group-not-found' } as const);
        return ok({ member: answer.member && !answer.archived });
      },
      { readOnly: true },
    );
  }
}
