import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import type { Clock } from '@mondapac/shared-kernel';
import {
  AUTHENTICATOR,
  AUTHORISATION_CHECK,
  PermissionRegistry,
  registerPermissions,
  USE_CASE_GATE,
  type UseCaseGate,
} from '../../platform/authz';
import { registerAuditActions } from '../../platform/audit/audit-action-catalogue';
import { AUDIT_WRITER } from '../../platform/audit/audit-writer';
import { CLOCK } from '../../platform/clock/clock.module';
import { registerEvents } from '../../platform/events/event-catalogue';
import { registerSubscriptionsFrom } from '../../platform/events/event-subscriptions';
import { OUTBOX_WRITER } from '../../platform/events/outbox-writer';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { MAIL_TRANSPORT } from '../../platform/mail/mail-transport';
import { MarketRegistry } from '../../platform/market-config/market-registry';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { registerJobsFrom } from '../../platform/scheduler/job-registry';
import { UNIT_OF_WORK, type UnitOfWork } from '../../platform/unit-of-work/unit-of-work';
import { AccountAuthorisationCheck } from './application/access/account-authorisation-check';
import {
  EFFECTIVE_KEY_RESOLVER,
  type EffectiveKeyResolver,
} from './application/access/effective-keys';
import { SessionAuthenticator } from './application/access/session-authenticator';
import { ACCESS_DECISION_REPOSITORY } from './application/ports/access-decision.repository';
import { ACCESS_REVIEWERS } from './application/ports/access-reviewers';
import { ACCOUNT_REPOSITORY, type AccountRepository } from './application/ports/account.repository';
import { COMMON_PASSWORD_LIST } from './application/ports/common-password-list';
import { IDENTITY_MAIL_COMPOSER } from './application/ports/identity-mails';
import { IDENTITY_MARKET_POLICY } from './application/ports/identity-market-policy';
import { INVITATION_REPOSITORY } from './application/ports/invitation.repository';
import { LINK_TARGETS, LINK_TOKENS } from './application/ports/link-secrets';
import { ONE_TIME_LINK_REPOSITORY } from './application/ports/one-time-link.repository';
import { PASSWORD_HASHER } from './application/ports/password-hasher';
import { ROLE_GRANT_READER, type RoleGrantReader } from './application/ports/role-grant-reader';
import { ROLE_SEED } from './application/ports/role-seed';
import {
  SELLER_ACCESS_REPOSITORY,
  type SellerAccessRepository,
} from './application/ports/seller-access.repository';
import {
  ROLE_ASSIGNMENT_REPOSITORY,
  ROLE_REPOSITORY,
  SELLER_MEMBERSHIP_REPOSITORY,
  type SellerMembershipRepository,
} from './application/ports/seller-team.repository';
import { SESSION_REPOSITORY, type SessionRepository } from './application/ports/session.repository';
import {
  SESSION_TOKENS,
  THROTTLE_KEYS,
  type SessionTokens,
} from './application/ports/session-secrets';
import {
  CHALLENGE_TOKENS,
  ENROLMENT_SECRET_TAGS,
  INVITATION_TOKENS,
} from './application/ports/second-factor-tokens';
import { SECOND_FACTOR_SECRETS } from './application/ports/second-factor-secrets';
import { SECOND_FACTOR_REPOSITORY } from './application/ports/second-factor.repository';
import { SIGN_IN_CHALLENGE_REPOSITORY } from './application/ports/sign-in-challenge.repository';
import { SIGN_IN_RECORD_REPOSITORY } from './application/ports/sign-in-record.repository';
import { THROTTLE_REPOSITORY } from './application/ports/throttle.repository';
import { AcceptAdminInvitation } from './application/use-cases/accept-admin-invitation.use-case';
import { AcceptSellerInvitation } from './application/use-cases/accept-seller-invitation.use-case';
import { ApproveSellerAccess } from './application/use-cases/approve-seller-access.use-case';
import { InviteSeller } from './application/use-cases/invite-seller.use-case';
import { ReapplySellerAccess } from './application/use-cases/reapply-seller-access.use-case';
import { ReinstateSellerAccess } from './application/use-cases/reinstate-seller-access.use-case';
import { RejectSellerAccess } from './application/use-cases/reject-seller-access.use-case';
import { ResendSellerInvitation } from './application/use-cases/resend-seller-invitation.use-case';
import { RevokeSellerInvitation } from './application/use-cases/revoke-seller-invitation.use-case';
import { SendSellerAccessMail } from './application/use-cases/send-seller-access-mail.use-case';
import { SuspendSellerAccess } from './application/use-cases/suspend-seller-access.use-case';
import { AssignAdminRole } from './application/use-cases/assign-admin-role.use-case';
import { ListAdminTeam } from './application/use-cases/list-admin-team.use-case';
import { ADMIN_ACCOUNT_READER } from './application/ports/admin-account-reader';
import { adminAccountReaderProvider } from './infrastructure/admin-team/prisma-admin-account-reader';
import { DisableAdminAccount } from './application/use-cases/disable-admin-account.use-case';
import { DisableCustomerAccount } from './application/use-cases/disable-customer-account.use-case';
import { EnableAdminAccount } from './application/use-cases/enable-admin-account.use-case';
import { EnableCustomerAccount } from './application/use-cases/enable-customer-account.use-case';
import { InviteAdmin } from './application/use-cases/invite-admin.use-case';
import { ResendAdminInvitation } from './application/use-cases/resend-admin-invitation.use-case';
import { ResetOtherAdminSecondFactor } from './application/use-cases/reset-other-admin-second-factor.use-case';
import { RevokeAdminInvitation } from './application/use-cases/revoke-admin-invitation.use-case';
import { ChangePassword } from './application/use-cases/change-password.use-case';
import { CompleteAdminSignIn } from './application/use-cases/complete-admin-sign-in.use-case';
import { ConfirmSecondFactorEnrolment } from './application/use-cases/confirm-second-factor-enrolment.use-case';
import { IssueFirstAdminInvitation } from './application/use-cases/issue-first-admin-invitation.use-case';
import { ResetAdminSecondFactor } from './application/use-cases/reset-admin-second-factor.use-case';
import { CompleteSecondFactorReplacement } from './application/use-cases/complete-second-factor-replacement.use-case';
import { RegenerateRecoveryCodes } from './application/use-cases/regenerate-recovery-codes.use-case';
import { StartSecondFactorReplacement } from './application/use-cases/start-second-factor-replacement.use-case';
import { SendInvitationMail } from './application/use-cases/send-invitation-mail.use-case';
import { SendSecondFactorMail } from './application/use-cases/send-second-factor-mail.use-case';
import { SignInAdmin } from './application/use-cases/sign-in-admin.use-case';
import { StartAdminInvitationAcceptance } from './application/use-cases/start-admin-invitation-acceptance.use-case';
import { StartSecondFactorEnrolment } from './application/use-cases/start-second-factor-enrolment.use-case';
import { ConfirmCustomerEmail } from './application/use-cases/confirm-customer-email.use-case';
import { ConfirmSellerEmail } from './application/use-cases/confirm-seller-email.use-case';
import { DescribeActor } from './application/use-cases/describe-actor.use-case';
import { DescribeSellerStatus } from './application/use-cases/describe-seller-status.use-case';
import { ListRegisteredSellers } from './application/use-cases/list-registered-sellers.use-case';
import { MembershipOf } from './application/use-cases/membership-of.use-case';
import { NotifyAccessReviewers } from './application/use-cases/notify-access-reviewers.use-case';
import { PurgeExpired } from './application/use-cases/purge-expired.use-case';
import { PurgeUnverifiedAccounts } from './application/use-cases/purge-unverified-accounts.use-case';
import { RegisterCustomer } from './application/use-cases/register-customer.use-case';
import { RegisterSeller } from './application/use-cases/register-seller.use-case';
import { RequestCustomerVerification } from './application/use-cases/request-customer-verification.use-case';
import { RequestPasswordReset } from './application/use-cases/request-password-reset.use-case';
import { RequestSellerVerification } from './application/use-cases/request-seller-verification.use-case';
import { ResetPassword } from './application/use-cases/reset-password.use-case';
import { SeedRoles } from './application/use-cases/seed-roles.use-case';
import { SellerAccessOf } from './application/use-cases/seller-access-of.use-case';
import { SellerAccessOfSystem } from './application/use-cases/seller-access-of-system.use-case';
import { SendExistingAccountMail } from './application/use-cases/send-existing-account-mail.use-case';
import { SendLinkMail } from './application/use-cases/send-link-mail.use-case';
import { SendPasswordChangedMail } from './application/use-cases/send-password-changed-mail.use-case';
import { SendWelcomeMail } from './application/use-cases/send-welcome-mail.use-case';
import { SignInCustomer } from './application/use-cases/sign-in-customer.use-case';
import { SignInSeller } from './application/use-cases/sign-in-seller.use-case';
import { SignOut } from './application/use-cases/sign-out.use-case';
import { TeamMembershipOf } from './application/use-cases/team-membership-of.use-case';
import { IDENTITY_FACADE } from './contracts/identity.facade';
import { IDENTITY_PERMISSIONS } from './contracts/permissions';
import { SELLER_ACCESS_CONTRACT } from './contracts/seller-access.contract';
import { IDENTITY_AUDIT_ACTIONS } from './domain/audit';
import { IDENTITY_EVENTS } from './domain/events';
import { accountRepositoryProvider } from './infrastructure/account-repository.provider';
import { linkProviders } from './infrastructure/links/link-providers';
import { MarketConfigIdentityPolicy } from './infrastructure/market-config-identity-policy';
import { Argon2idPasswordHasher } from './infrastructure/passwords/argon2id-password-hasher';
import { CheckedInCommonPasswords } from './infrastructure/passwords/checked-in-common-passwords';
import { reviewerProviders } from './infrastructure/reviewers/reviewer-providers';
import { roleProviders } from './infrastructure/roles/role-providers';
import { secondFactorProviders } from './infrastructure/second-factor/second-factor-providers';
import { sellerProviders } from './infrastructure/sellers/seller-providers';
import { sessionProviders } from './infrastructure/sessions/session-providers';
import { AdminPasswordController } from './presentation/admin-password.controller';
import { AdminSecondFactorController } from './presentation/admin-second-factor.controller';
import { AdminSessionController } from './presentation/admin-session.controller';
import { AdminSellersController } from './presentation/admin-sellers.controller';
import { AdminTeamController } from './presentation/admin-team.controller';
import { CustomerEmailVerificationController } from './presentation/customer-email-verification.controller';
import { CustomerPasswordController } from './presentation/customer-password.controller';
import { CustomerSessionController } from './presentation/customer-session.controller';
import { CustomerSignUpController } from './presentation/customer-sign-up.controller';
import { IdentityFacadeImplementation } from './presentation/identity.facade';
import { SellerAccessContractImplementation } from './presentation/seller-access.contract';
import { purgeExpiredJob } from './presentation/jobs/purge-expired.job';
import { purgeUnverifiedAccountsJob } from './presentation/jobs/purge-unverified-accounts.job';
import { seedRolesJob } from './presentation/jobs/seed-roles.job';
import { SellerPasswordController } from './presentation/seller-password.controller';
import { SellerSessionController } from './presentation/seller-session.controller';
import { SellerSignUpController } from './presentation/seller-sign-up.controller';
import { identityMailSubscriptions } from './presentation/subscribers/mail.subscriptions';

/**
 * The Nest token of each dependency name the use cases of identity share: a use case's
 * dependency object is built from these by {@link useCaseProvider}, so a name always means the
 * same port.
 */
const PORT = {
  unitOfWork: UNIT_OF_WORK,
  accounts: ACCOUNT_REPOSITORY,
  adminAccounts: ADMIN_ACCOUNT_READER,
  sessions: SESSION_REPOSITORY,
  throttles: THROTTLE_REPOSITORY,
  records: SIGN_IN_RECORD_REPOSITORY,
  links: ONE_TIME_LINK_REPOSITORY,
  challenges: SIGN_IN_CHALLENGE_REPOSITORY,
  invitations: INVITATION_REPOSITORY,
  sellerAccess: SELLER_ACCESS_REPOSITORY,
  decisions: ACCESS_DECISION_REPOSITORY,
  reviewers: ACCESS_REVIEWERS,
  memberships: SELLER_MEMBERSHIP_REPOSITORY,
  roles: ROLE_REPOSITORY,
  assignments: ROLE_ASSIGNMENT_REPOSITORY,
  grants: ROLE_GRANT_READER,
  effectiveKeys: EFFECTIVE_KEY_RESOLVER,
  permissions: PermissionRegistry,
  seed: ROLE_SEED,
  hasher: PASSWORD_HASHER,
  commonPasswords: COMMON_PASSWORD_LIST,
  tokens: SESSION_TOKENS,
  keys: THROTTLE_KEYS,
  linkTokens: LINK_TOKENS,
  targets: LINK_TARGETS,
  composer: IDENTITY_MAIL_COMPOSER,
  transport: MAIL_TRANSPORT,
  outbox: OUTBOX_WRITER,
  audit: AUDIT_WRITER,
  policy: IDENTITY_MARKET_POLICY,
  clock: CLOCK,
  ids: ID_GENERATOR,
  factors: SECOND_FACTOR_REPOSITORY,
  secrets: SECOND_FACTOR_SECRETS,
  challengeTokens: CHALLENGE_TOKENS,
  invitationTokens: INVITATION_TOKENS,
  enrolmentTags: ENROLMENT_SECRET_TAGS,
} as const satisfies Record<string, InjectionToken>;

type PortName = keyof typeof PORT;

/**
 * The provider of one use case: the gate and the named ports, in a dependency object. `ports`
 * names every key of the use case's own dependency type, each a key of {@link PORT}, and no
 * other: the type checker refuses a missing, unknown or misnamed dependency.
 */
function useCaseProvider<D, U>(
  type: new (gate: UseCaseGate, deps: D) => U,
  ports: { readonly [K in keyof D]-?: K extends PortName ? true : never },
): FactoryProvider<U> {
  const names = Object.keys(ports) as PortName[];
  return {
    provide: type,
    inject: [USE_CASE_GATE, ...names.map((name) => PORT[name])],
    useFactory: (gate: UseCaseGate, ...values: unknown[]) =>
      new type(gate, Object.fromEntries(names.map((name, index) => [name, values[index]])) as D),
  };
}

/**
 * The identity bounded context (ADR-0018; docs/design/domain/identity.md), filled slice by
 * slice. Slice 1b binds its outbox writer and registers its events (platform persistence
 * design 5.2, PN6). Slice 1d binds the password hasher (one per process: its queue is the
 * process's), the common-password list, the Market policy, the account repository, the
 * customer sign-up use case and its controller.
 *
 * Slice 2 binds the session, throttle and sign-in-record stores, the session tokens and the
 * throttle keys; the customer sign-in, sign-out and summary use cases and their controller; the
 * `identity.purge-expired` job; the facade; and the two ports `platform/` calls, exported for
 * it: the `Authenticator` (the actor guard) and the `AuthorisationCheck` (the gate, through
 * `AuthzModule.register(IdentityModule)`).
 *
 * Slice 3 binds the one-time links, the link tokens and targets and the mail composer; the
 * email confirmation and "send it again" use cases and their controller; identity's two mail
 * handlers, subscribed to its own events (the first subscriptions, identity design 9); and the
 * `identity.purge-unverified-accounts` job.
 *
 * Slice 5 binds the seller access, membership, role and assignment stores and the role seed;
 * seller self-registration, sign-in, email confirmation, "send it again" and status, with their
 * two controllers; `membershipOf`, `sellerAccessOf` (its two use cases) and the registered
 * seller paging behind the facade; the welcome mail handler; and the `identity.seed-roles` job.
 *
 * Slice 4 binds the password reset request, the reset with a link and the signed-in change, with
 * one controller per population, and the "password changed" mail handler.
 *
 * R-3 binds the reviewer read and the reviewer notice behind the seller-access contract
 * (identity design 8.7). No subscription sends it: only `sellers` calls it, after a submission.
 *
 * Slice 6b registers identity's audited actions and binds its own audit writer
 * (docs/design/domain/platform-audit.md 2, 5): the seed writes `identity.role.seeded`, and the
 * Seller Owner's email confirmation writes the three founding rows. No other module binds one.
 *
 * Slice 8a-1 pushes identity's permission catalogue into the registry; binds the grant read and
 * the one effective-key resolver (`EFFECTIVE_KEY_RESOLVER`, R-3 review N-1), injected by the
 * `AuthorisationCheck`, the reviewer read and the actor summary alike; checks the seed's keys at
 * boot; seeds the default roles and applies newer seed versions (`SeedRoles`); and binds
 * `membershipOf` for other accounts (`TeamMembershipOf`, `identity.team-member.view`).
 *
 * Slices 8a-2 and 8b bind the admin team: an admin's role change (`AssignAdminRole`, HF8), admin
 * invitations with an inviter (issue, resend, revoke; the acceptance re-checks the inviter),
 * disabling and enabling admin and customer accounts, and the admin-initiated second-factor
 * reset, behind one controller (`AdminTeamController`).
 *
 * Slice 8c binds the admin team list (`ListAdminTeam`, `identity.admin-account.view`) and its
 * account read, on the same controller.
 *
 * Slice 9 binds the access decisions (approve, reject, suspend, reinstate) with their store and
 * encrypted reasons, the decision mails (four subscriptions, E4 to E7), re-apply behind the
 * seller-access contract, and a seller created by an admin's invitation (issue, re-send, revoke,
 * and the owner's acceptance), behind `AdminSellersController` and the seller sign-up controller.
 */
@Module({
  controllers: [
    CustomerSignUpController,
    CustomerSessionController,
    CustomerEmailVerificationController,
    SellerSignUpController,
    SellerSessionController,
    CustomerPasswordController,
    SellerPasswordController,
    AdminSessionController,
    AdminSecondFactorController,
    AdminPasswordController,
    AdminTeamController,
    AdminSellersController,
  ],
  providers: [
    PersistenceModule.outboxWriterFor('identity'),
    registerEvents('identity', IDENTITY_EVENTS),
    PersistenceModule.auditWriterFor('identity'),
    registerAuditActions('identity', IDENTITY_AUDIT_ACTIONS),
    registerPermissions('identity', IDENTITY_PERMISSIONS),
    { provide: PASSWORD_HASHER, useFactory: () => new Argon2idPasswordHasher() },
    { provide: COMMON_PASSWORD_LIST, useFactory: () => new CheckedInCommonPasswords() },
    {
      provide: IDENTITY_MARKET_POLICY,
      inject: [MarketRegistry],
      useFactory: (markets: MarketRegistry) => new MarketConfigIdentityPolicy(markets),
    },
    accountRepositoryProvider,
    ...sessionProviders,
    ...linkProviders,
    ...sellerProviders,
    ...reviewerProviders,
    ...roleProviders,
    ...secondFactorProviders,
    adminAccountReaderProvider,
    {
      provide: AUTHENTICATOR,
      inject: [UNIT_OF_WORK, SESSION_REPOSITORY, SESSION_TOKENS, CLOCK],
      useFactory: (
        unitOfWork: UnitOfWork,
        sessions: SessionRepository,
        tokens: SessionTokens,
        clock: Clock,
      ) => new SessionAuthenticator({ unitOfWork, sessions, tokens, clock }),
    },
    {
      provide: AUTHORISATION_CHECK,
      inject: [
        UNIT_OF_WORK,
        ACCOUNT_REPOSITORY,
        SELLER_MEMBERSHIP_REPOSITORY,
        SELLER_ACCESS_REPOSITORY,
        ROLE_GRANT_READER,
        EFFECTIVE_KEY_RESOLVER,
      ],
      useFactory: (
        unitOfWork: UnitOfWork,
        accounts: AccountRepository,
        memberships: SellerMembershipRepository,
        sellerAccess: SellerAccessRepository,
        grants: RoleGrantReader,
        effectiveKeys: EffectiveKeyResolver,
      ) =>
        new AccountAuthorisationCheck({
          unitOfWork,
          accounts,
          memberships,
          sellerAccess,
          grants,
          effectiveKeys,
        }),
    },
    useCaseProvider(RegisterCustomer, {
      unitOfWork: true,
      accounts: true,
      links: true,
      throttles: true,
      keys: true,
      outbox: true,
      hasher: true,
      commonPasswords: true,
      policy: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(SignInCustomer, {
      unitOfWork: true,
      accounts: true,
      sessions: true,
      throttles: true,
      records: true,
      hasher: true,
      tokens: true,
      keys: true,
      policy: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(SignOut, { unitOfWork: true, sessions: true, clock: true }),
    useCaseProvider(DescribeActor, {
      unitOfWork: true,
      accounts: true,
      sessions: true,
      sellerAccess: true,
      grants: true,
      effectiveKeys: true,
      factors: true,
    }),
    useCaseProvider(PurgeExpired, {
      unitOfWork: true,
      sessions: true,
      challenges: true,
      invitations: true,
      throttles: true,
      records: true,
      links: true,
      policy: true,
      clock: true,
    }),
    useCaseProvider(ConfirmCustomerEmail, {
      unitOfWork: true,
      accounts: true,
      sessions: true,
      throttles: true,
      records: true,
      hasher: true,
      tokens: true,
      keys: true,
      policy: true,
      clock: true,
      ids: true,
      links: true,
      outbox: true,
      linkTokens: true,
    }),
    useCaseProvider(RequestCustomerVerification, {
      unitOfWork: true,
      accounts: true,
      links: true,
      throttles: true,
      keys: true,
      outbox: true,
      policy: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(SendLinkMail, {
      unitOfWork: true,
      accounts: true,
      links: true,
      linkTokens: true,
      targets: true,
      composer: true,
      transport: true,
      policy: true,
      clock: true,
    }),
    useCaseProvider(SendExistingAccountMail, {
      unitOfWork: true,
      accounts: true,
      targets: true,
      composer: true,
      transport: true,
      policy: true,
    }),
    useCaseProvider(PurgeUnverifiedAccounts, {
      unitOfWork: true,
      accounts: true,
      memberships: true,
      assignments: true,
      sellerAccess: true,
      policy: true,
      clock: true,
    }),
    useCaseProvider(RegisterSeller, {
      unitOfWork: true,
      accounts: true,
      sellerAccess: true,
      memberships: true,
      roles: true,
      assignments: true,
      links: true,
      throttles: true,
      keys: true,
      outbox: true,
      hasher: true,
      commonPasswords: true,
      policy: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(SignInSeller, {
      unitOfWork: true,
      accounts: true,
      sessions: true,
      throttles: true,
      records: true,
      hasher: true,
      tokens: true,
      keys: true,
      policy: true,
      clock: true,
      ids: true,
      memberships: true,
      sellerAccess: true,
      decisions: true,
      grants: true,
    }),
    useCaseProvider(ConfirmSellerEmail, {
      unitOfWork: true,
      accounts: true,
      sessions: true,
      throttles: true,
      records: true,
      hasher: true,
      tokens: true,
      keys: true,
      policy: true,
      clock: true,
      ids: true,
      links: true,
      outbox: true,
      linkTokens: true,
      memberships: true,
      sellerAccess: true,
      decisions: true,
      grants: true,
      audit: true,
      assignments: true,
    }),
    useCaseProvider(RequestSellerVerification, {
      unitOfWork: true,
      accounts: true,
      links: true,
      throttles: true,
      keys: true,
      outbox: true,
      policy: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(DescribeSellerStatus, {
      unitOfWork: true,
      accounts: true,
      sellerAccess: true,
      decisions: true,
      grants: true,
      policy: true,
    }),
    useCaseProvider(MembershipOf, { unitOfWork: true, memberships: true, assignments: true }),
    useCaseProvider(TeamMembershipOf, { unitOfWork: true, memberships: true, assignments: true }),
    useCaseProvider(SellerAccessOf, { unitOfWork: true, sellerAccess: true }),
    useCaseProvider(SellerAccessOfSystem, { unitOfWork: true, sellerAccess: true }),
    useCaseProvider(ListRegisteredSellers, { unitOfWork: true, sellerAccess: true }),
    useCaseProvider(NotifyAccessReviewers, {
      unitOfWork: true,
      sellerAccess: true,
      reviewers: true,
      targets: true,
      composer: true,
      transport: true,
      policy: true,
    }),
    useCaseProvider(SeedRoles, {
      unitOfWork: true,
      roles: true,
      seed: true,
      permissions: true,
      clock: true,
      ids: true,
      audit: true,
    }),
    useCaseProvider(SendWelcomeMail, {
      unitOfWork: true,
      accounts: true,
      targets: true,
      composer: true,
      transport: true,
      policy: true,
    }),
    useCaseProvider(RequestPasswordReset, {
      unitOfWork: true,
      accounts: true,
      links: true,
      throttles: true,
      keys: true,
      outbox: true,
      policy: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(ResetPassword, {
      unitOfWork: true,
      accounts: true,
      challenges: true,
      factors: true,
      links: true,
      sessions: true,
      throttles: true,
      records: true,
      ids: true,
      keys: true,
      linkTokens: true,
      outbox: true,
      hasher: true,
      commonPasswords: true,
      policy: true,
      clock: true,
    }),
    useCaseProvider(ChangePassword, {
      unitOfWork: true,
      accounts: true,
      challenges: true,
      factors: true,
      secrets: true,
      sessions: true,
      links: true,
      throttles: true,
      records: true,
      ids: true,
      keys: true,
      tokens: true,
      outbox: true,
      hasher: true,
      commonPasswords: true,
      policy: true,
      clock: true,
    }),
    useCaseProvider(SendPasswordChangedMail, {
      unitOfWork: true,
      accounts: true,
      composer: true,
      transport: true,
      policy: true,
    }),
    // Slice 7b: admin sign-in with its second factor, enrolment, devices, invitations.
    useCaseProvider(SignInAdmin, {
      unitOfWork: true,
      accounts: true,
      sessions: true,
      throttles: true,
      records: true,
      hasher: true,
      tokens: true,
      keys: true,
      policy: true,
      clock: true,
      ids: true,
      factors: true,
      challenges: true,
      links: true,
      outbox: true,
      challengeTokens: true,
    }),
    useCaseProvider(CompleteAdminSignIn, {
      unitOfWork: true,
      accounts: true,
      challenges: true,
      factors: true,
      throttles: true,
      records: true,
      keys: true,
      secrets: true,
      challengeTokens: true,
      outbox: true,
      clock: true,
      ids: true,
      sessions: true,
      tokens: true,
      audit: true,
      policy: true,
    }),
    useCaseProvider(StartSecondFactorEnrolment, {
      unitOfWork: true,
      accounts: true,
      links: true,
      factors: true,
      challenges: true,
      throttles: true,
      records: true,
      keys: true,
      linkTokens: true,
      challengeTokens: true,
      secrets: true,
      hasher: true,
      policy: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(ConfirmSecondFactorEnrolment, {
      unitOfWork: true,
      accounts: true,
      challenges: true,
      factors: true,
      throttles: true,
      records: true,
      keys: true,
      secrets: true,
      challengeTokens: true,
      outbox: true,
      clock: true,
      ids: true,
      sessions: true,
      audit: true,
      policy: true,
    }),
    useCaseProvider(StartSecondFactorReplacement, {
      unitOfWork: true,
      accounts: true,
      factors: true,
      throttles: true,
      keys: true,
      secrets: true,
      outbox: true,
      clock: true,
      audit: true,
      policy: true,
    }),
    useCaseProvider(CompleteSecondFactorReplacement, {
      unitOfWork: true,
      accounts: true,
      factors: true,
      throttles: true,
      keys: true,
      secrets: true,
      outbox: true,
      clock: true,
      audit: true,
      policy: true,
      sessions: true,
      challenges: true,
      tokens: true,
    }),
    useCaseProvider(RegenerateRecoveryCodes, {
      unitOfWork: true,
      accounts: true,
      factors: true,
      throttles: true,
      keys: true,
      secrets: true,
      outbox: true,
      clock: true,
      audit: true,
      policy: true,
    }),
    useCaseProvider(IssueFirstAdminInvitation, {
      unitOfWork: true,
      accounts: true,
      roles: true,
      invitations: true,
      outbox: true,
      audit: true,
      policy: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(StartAdminInvitationAcceptance, {
      unitOfWork: true,
      invitations: true,
      throttles: true,
      keys: true,
      invitationTokens: true,
      secrets: true,
      enrolmentTags: true,
      policy: true,
      clock: true,
    }),
    useCaseProvider(AcceptAdminInvitation, {
      unitOfWork: true,
      accounts: true,
      invitations: true,
      roles: true,
      assignments: true,
      factors: true,
      throttles: true,
      keys: true,
      invitationTokens: true,
      enrolmentTags: true,
      secrets: true,
      hasher: true,
      commonPasswords: true,
      grants: true,
      effectiveKeys: true,
      permissions: true,
      outbox: true,
      audit: true,
      policy: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(ResetAdminSecondFactor, {
      unitOfWork: true,
      accounts: true,
      factors: true,
      sessions: true,
      challenges: true,
      outbox: true,
      audit: true,
      clock: true,
    }),
    useCaseProvider(ListAdminTeam, {
      unitOfWork: true,
      accounts: true,
      adminAccounts: true,
      invitations: true,
      roles: true,
      assignments: true,
      grants: true,
      effectiveKeys: true,
      permissions: true,
      factors: true,
      policy: true,
      clock: true,
    }),
    useCaseProvider(AssignAdminRole, {
      unitOfWork: true,
      accounts: true,
      roles: true,
      assignments: true,
      grants: true,
      effectiveKeys: true,
      permissions: true,
      outbox: true,
      audit: true,
      clock: true,
    }),
    useCaseProvider(InviteAdmin, {
      unitOfWork: true,
      accounts: true,
      roles: true,
      grants: true,
      effectiveKeys: true,
      permissions: true,
      invitations: true,
      outbox: true,
      audit: true,
      policy: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(ResendAdminInvitation, {
      unitOfWork: true,
      accounts: true,
      roles: true,
      grants: true,
      effectiveKeys: true,
      permissions: true,
      invitations: true,
      outbox: true,
      audit: true,
      policy: true,
      clock: true,
    }),
    useCaseProvider(RevokeAdminInvitation, {
      unitOfWork: true,
      accounts: true,
      grants: true,
      effectiveKeys: true,
      invitations: true,
      outbox: true,
      audit: true,
      clock: true,
    }),
    useCaseProvider(DisableAdminAccount, {
      unitOfWork: true,
      accounts: true,
      roles: true,
      assignments: true,
      grants: true,
      effectiveKeys: true,
      sessions: true,
      challenges: true,
      outbox: true,
      audit: true,
      clock: true,
    }),
    useCaseProvider(EnableAdminAccount, {
      unitOfWork: true,
      accounts: true,
      roles: true,
      assignments: true,
      grants: true,
      effectiveKeys: true,
      sessions: true,
      challenges: true,
      outbox: true,
      audit: true,
      clock: true,
    }),
    useCaseProvider(DisableCustomerAccount, {
      unitOfWork: true,
      accounts: true,
      roles: true,
      assignments: true,
      grants: true,
      effectiveKeys: true,
      sessions: true,
      challenges: true,
      outbox: true,
      audit: true,
      clock: true,
    }),
    useCaseProvider(EnableCustomerAccount, {
      unitOfWork: true,
      accounts: true,
      roles: true,
      assignments: true,
      grants: true,
      effectiveKeys: true,
      sessions: true,
      challenges: true,
      outbox: true,
      audit: true,
      clock: true,
    }),
    useCaseProvider(ResetOtherAdminSecondFactor, {
      unitOfWork: true,
      accounts: true,
      roles: true,
      assignments: true,
      grants: true,
      effectiveKeys: true,
      factors: true,
      sessions: true,
      challenges: true,
      outbox: true,
      audit: true,
      clock: true,
    }),
    useCaseProvider(SendInvitationMail, {
      unitOfWork: true,
      invitations: true,
      invitationTokens: true,
      targets: true,
      composer: true,
      transport: true,
      policy: true,
      clock: true,
    }),
    useCaseProvider(SendSecondFactorMail, {
      unitOfWork: true,
      accounts: true,
      composer: true,
      transport: true,
      policy: true,
    }),
    // Slice 9: the access decisions, re-apply, the decision mails and the seller invitations.
    useCaseProvider(ApproveSellerAccess, {
      unitOfWork: true,
      sellerAccess: true,
      decisions: true,
      accounts: true,
      memberships: true,
      grants: true,
      effectiveKeys: true,
      sessions: true,
      challenges: true,
      outbox: true,
      audit: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(RejectSellerAccess, {
      unitOfWork: true,
      sellerAccess: true,
      decisions: true,
      accounts: true,
      memberships: true,
      grants: true,
      effectiveKeys: true,
      sessions: true,
      challenges: true,
      outbox: true,
      audit: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(SuspendSellerAccess, {
      unitOfWork: true,
      sellerAccess: true,
      decisions: true,
      accounts: true,
      memberships: true,
      grants: true,
      effectiveKeys: true,
      sessions: true,
      challenges: true,
      outbox: true,
      audit: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(ReinstateSellerAccess, {
      unitOfWork: true,
      sellerAccess: true,
      decisions: true,
      accounts: true,
      memberships: true,
      grants: true,
      effectiveKeys: true,
      sessions: true,
      challenges: true,
      outbox: true,
      audit: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(ReapplySellerAccess, {
      unitOfWork: true,
      sellerAccess: true,
      accounts: true,
      memberships: true,
      grants: true,
      effectiveKeys: true,
      policy: true,
      outbox: true,
      audit: true,
      clock: true,
    }),
    useCaseProvider(SendSellerAccessMail, {
      unitOfWork: true,
      decisions: true,
      memberships: true,
      grants: true,
      accounts: true,
      targets: true,
      composer: true,
      transport: true,
      policy: true,
    }),
    useCaseProvider(InviteSeller, {
      unitOfWork: true,
      accounts: true,
      roles: true,
      grants: true,
      effectiveKeys: true,
      sellerAccess: true,
      memberships: true,
      invitations: true,
      throttles: true,
      keys: true,
      targets: true,
      outbox: true,
      audit: true,
      policy: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(ResendSellerInvitation, {
      unitOfWork: true,
      accounts: true,
      grants: true,
      effectiveKeys: true,
      invitations: true,
      throttles: true,
      keys: true,
      outbox: true,
      audit: true,
      policy: true,
      clock: true,
    }),
    useCaseProvider(RevokeSellerInvitation, {
      unitOfWork: true,
      accounts: true,
      grants: true,
      effectiveKeys: true,
      invitations: true,
      throttles: true,
      keys: true,
      outbox: true,
      audit: true,
      policy: true,
      clock: true,
    }),
    useCaseProvider(AcceptSellerInvitation, {
      unitOfWork: true,
      accounts: true,
      invitations: true,
      roles: true,
      assignments: true,
      memberships: true,
      sellerAccess: true,
      grants: true,
      effectiveKeys: true,
      throttles: true,
      keys: true,
      invitationTokens: true,
      hasher: true,
      commonPasswords: true,
      outbox: true,
      audit: true,
      policy: true,
      clock: true,
      ids: true,
    }),
    {
      provide: IDENTITY_FACADE,
      inject: [DescribeActor, MembershipOf, TeamMembershipOf],
      useFactory: (
        describeActor: DescribeActor,
        membershipOf: MembershipOf,
        teamMembershipOf: TeamMembershipOf,
      ) => new IdentityFacadeImplementation({ describeActor, membershipOf, teamMembershipOf }),
    },
    {
      // The calls only `sellers` may consume (ADR-0022 decision 6): a token of their own,
      // imported through a contract file that is not in index.ts and that a boundary rule
      // limits to modules/sellers/.
      provide: SELLER_ACCESS_CONTRACT,
      inject: [
        SellerAccessOf,
        SellerAccessOfSystem,
        ListRegisteredSellers,
        NotifyAccessReviewers,
        ApproveSellerAccess,
        RejectSellerAccess,
        ReapplySellerAccess,
      ],
      useFactory: (
        sellerAccessOf: SellerAccessOf,
        sellerAccessOfSystem: SellerAccessOfSystem,
        listRegisteredSellers: ListRegisteredSellers,
        notifyAccessReviewers: NotifyAccessReviewers,
        approveSellerAccess: ApproveSellerAccess,
        rejectSellerAccess: RejectSellerAccess,
        reapplySellerAccess: ReapplySellerAccess,
      ) =>
        new SellerAccessContractImplementation({
          sellerAccessOf,
          sellerAccessOfSystem,
          listRegisteredSellers,
          notifyAccessReviewers,
          approveSellerAccess,
          rejectSellerAccess,
          reapplySellerAccess,
        }),
    },
    registerJobsFrom(
      'identity',
      [PurgeExpired, PurgeUnverifiedAccounts, SeedRoles],
      (purge: PurgeExpired, purgeUnverified: PurgeUnverifiedAccounts, seedRoles: SeedRoles) => [
        purgeExpiredJob(purge),
        purgeUnverifiedAccountsJob(purgeUnverified),
        seedRolesJob(seedRoles),
      ],
    ),
    registerSubscriptionsFrom(
      'identity',
      [
        SendLinkMail,
        SendExistingAccountMail,
        SendWelcomeMail,
        SendPasswordChangedMail,
        SendInvitationMail,
        SendSecondFactorMail,
        SendSellerAccessMail,
      ],
      (
        sendLinkMail: SendLinkMail,
        sendExistingAccountMail: SendExistingAccountMail,
        sendWelcomeMail: SendWelcomeMail,
        sendPasswordChangedMail: SendPasswordChangedMail,
        sendInvitationMail: SendInvitationMail,
        sendSecondFactorMail: SendSecondFactorMail,
        sendSellerAccessMail: SendSellerAccessMail,
      ) =>
        identityMailSubscriptions(
          sendLinkMail,
          sendExistingAccountMail,
          sendWelcomeMail,
          sendPasswordChangedMail,
          sendInvitationMail,
          sendSecondFactorMail,
          sendSellerAccessMail,
        ),
    ),
  ],
  exports: [AUTHENTICATOR, AUTHORISATION_CHECK, IDENTITY_FACADE, SELLER_ACCESS_CONTRACT],
})
export class IdentityModule {}
