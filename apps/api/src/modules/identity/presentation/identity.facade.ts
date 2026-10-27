import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { ConfirmSellerSecondFactor } from '../application/use-cases/confirm-seller-second-factor.use-case';
import type { ContactEmailOf } from '../application/use-cases/contact-email-of.use-case';
import type { CustomerAccountSummaries } from '../application/use-cases/customer-account-summaries.use-case';
import type { CustomerShortNames } from '../application/use-cases/customer-short-names.use-case';
import type { CustomerAccountExists } from '../application/use-cases/customer-account-exists.use-case';
import type { EndAllCustomerSessions } from '../application/use-cases/end-all-customer-sessions.use-case';
import type { EndOtherCustomerSessions } from '../application/use-cases/end-other-customer-sessions.use-case';
import type { EraseCustomerAccount } from '../application/use-cases/erase-customer-account.use-case';
import type { DescribeActor } from '../application/use-cases/describe-actor.use-case';
import type { RequireStepUp } from '../application/use-cases/require-step-up.use-case';
import type { MembershipOf } from '../application/use-cases/membership-of.use-case';
import type { TeamMemberLabels } from '../application/use-cases/team-member-labels.use-case';
import type { TeamMembershipOf } from '../application/use-cases/team-membership-of.use-case';
import type {
  ActorDescription,
  ConfirmSecondFactorFailure,
  ContactEmailTarget,
  CustomerAccountSummary,
  CustomerShortName,
  EndOtherCustomerSessionsFailure,
  IdentityFacade,
  IdentityValidationFailed,
  SellerMembershipSummary,
  TeamMemberLabel,
} from '../contracts/identity.facade';
import type { StepUpFailure } from '../contracts/step-up';

/** The use cases behind the facade, one per method. */
export interface IdentityFacadeUseCases {
  readonly describeActor: DescribeActor;
  readonly membershipOf: MembershipOf;
  readonly teamMembershipOf: TeamMembershipOf;
  readonly confirmSellerSecondFactor: ConfirmSellerSecondFactor;
  readonly contactEmailOf: ContactEmailOf;
  readonly requireStepUp: RequireStepUp;
  readonly customerAccountSummaries: CustomerAccountSummaries;
  readonly customerShortNames: CustomerShortNames;
  readonly teamMemberLabels: TeamMemberLabels;
  readonly endOtherCustomerSessions: EndOtherCustomerSessions;
  readonly endAllCustomerSessions: EndAllCustomerSessions;
  readonly customerAccountExists: CustomerAccountExists;
  readonly eraseCustomerAccount: EraseCustomerAccount;
}

/**
 * The implementation of {@link IdentityFacade} (identity design 8.1): each method passes the
 * caller's `CallContext` unchanged to one use case through `execute`, so the gate runs, and
 * returns ids and codes only: the name and the email of the HTTP summary are dropped here.
 */
export class IdentityFacadeImplementation implements IdentityFacade {
  constructor(private readonly useCases: IdentityFacadeUseCases) {}

  async describeActor(context: CallContext): Promise<Result<ActorDescription, AccessDenied>> {
    const result = await this.useCases.describeActor.execute(context, {});
    // A summary that vanished under a concurrent revocation is `access.denied`, as the gate's.
    if (!result.ok) return err(result.error);
    const summary = result.value;
    return ok({
      accountId: summary.accountId,
      population: summary.population,
      sellerId: summary.sellerId,
      roleId: summary.roleId,
      permissionKeys: summary.permissionKeys,
      sellerAccessState: summary.sellerAccessState,
      secondFactorActive: summary.secondFactorActive,
    });
  }

  /**
   * Two use cases behind one method (as `sellerAccessOf`): the actor's own id goes to
   * `identity.membership-of` (`own-resources`, allowed when not approved); any other id to
   * `identity.team-membership-of` (`identity.team-member.view`, slice 8a-1). Each runs the gate.
   */
  membershipOf(
    context: CallContext,
    accountId: Id<'Account'>,
  ): Promise<Result<SellerMembershipSummary, AccessDenied>> {
    const own = context.actor.kind === 'authenticated' && context.actor.accountId === accountId;
    return own
      ? this.useCases.membershipOf.execute(context, { accountId })
      : this.useCases.teamMembershipOf.execute(context, { accountId });
  }

  async confirmSecondFactor(
    context: CallContext,
    code: string,
  ): Promise<Result<void, ConfirmSecondFactorFailure>> {
    const result = await this.useCases.confirmSellerSecondFactor.execute(context, { code });
    return result.ok ? ok(undefined) : err(result.error);
  }

  contactEmailOf(
    context: CallContext,
    target: ContactEmailTarget,
  ): Promise<Result<string | null, AccessDenied>> {
    return this.useCases.contactEmailOf.execute(context, target);
  }

  async requireStepUp(
    context: CallContext,
    actionKey: string,
  ): Promise<Result<void, StepUpFailure>> {
    const result = await this.useCases.requireStepUp.execute(context, { actionKey });
    return result.ok ? ok(undefined) : err(result.error);
  }

  customerAccountSummaries(
    context: CallContext,
    accountIds: readonly Id<'Account'>[],
  ): Promise<Result<readonly CustomerAccountSummary[], AccessDenied | IdentityValidationFailed>> {
    return this.useCases.customerAccountSummaries.execute(context, { accountIds });
  }

  customerShortNames(
    context: CallContext,
    accountIds: readonly Id<'Account'>[],
  ): Promise<Result<readonly CustomerShortName[], AccessDenied | IdentityValidationFailed>> {
    return this.useCases.customerShortNames.execute(context, { accountIds });
  }

  async teamMemberLabels(
    context: CallContext,
    accountIds: readonly Id<'Account'>[],
  ): Promise<Result<readonly TeamMemberLabel[], AccessDenied | IdentityValidationFailed>> {
    const result = await this.useCases.teamMemberLabels.execute(context, { accountIds });
    if (!result.ok) return err(result.error);
    // The role id stays inside identity; the label is enough to show the row.
    return ok(
      result.value.map((row) => ({
        accountId: row.accountId,
        displayName: row.displayName,
        role:
          row.role === null
            ? null
            : { kind: row.role.kind, seedCode: row.role.seedCode, name: row.role.name },
      })),
    );
  }

  async endOtherCustomerSessions(
    context: CallContext,
  ): Promise<Result<{ readonly revokedSessions: number }, EndOtherCustomerSessionsFailure>> {
    const result = await this.useCases.endOtherCustomerSessions.execute(context, {});
    return result.ok ? ok({ revokedSessions: result.value.revokedSessions }) : err(result.error);
  }

  async endAllCustomerSessions(
    context: CallContext,
    accountId: Id<'Account'>,
    requestId: Id<'AccountDeletionRequest'>,
  ): Promise<Result<{ readonly revokedSessions: number }, AccessDenied>> {
    const result = await this.useCases.endAllCustomerSessions.execute(context, {
      accountId,
      requestId,
    });
    return result.ok ? ok({ revokedSessions: result.value.revokedSessions }) : err(result.error);
  }

  async customerAccountExists(
    context: CallContext,
    accountId: Id<'Account'>,
  ): Promise<Result<{ readonly exists: boolean }, AccessDenied>> {
    const result = await this.useCases.customerAccountExists.execute(context, { accountId });
    return result.ok ? ok({ exists: result.value.exists }) : err(result.error);
  }

  async eraseCustomerAccount(
    context: CallContext,
    accountId: Id<'Account'>,
    requestId: Id<'AccountDeletionRequest'>,
  ): Promise<Result<{ readonly code: 'erased' | 'already-erased' }, AccessDenied>> {
    const result = await this.useCases.eraseCustomerAccount.execute(context, {
      accountId,
      requestId,
    });
    return result.ok ? ok({ code: result.value.code }) : err(result.error);
  }
}
