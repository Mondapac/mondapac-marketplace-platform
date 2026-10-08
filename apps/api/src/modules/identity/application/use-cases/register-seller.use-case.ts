import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, IdGenerator, Result, Temporal } from '@mondapac/shared-kernel';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { TransactionConflictError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { Account } from '../../domain/account';
import { parseDisplayName } from '../../domain/display-name';
import { parseEmailAddress, type EmailAddress } from '../../domain/email-address';
import { OneTimeLink } from '../../domain/one-time-link';
import { checkNewPassword, type PasswordRejected } from '../../domain/password-policy';
import { RoleAssignment } from '../../domain/role';
import { SellerAccess } from '../../domain/seller-access';
import { SellerMembership } from '../../domain/seller-membership';
import type { AccountRepository } from '../ports/account.repository';
import type { CommonPasswordList } from '../ports/common-password-list';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { OneTimeLinkRepository } from '../ports/one-time-link.repository';
import type { PasswordHasher, PasswordHasherBusy } from '../ports/password-hasher';
import type { SellerAccessRepository } from '../ports/seller-access.repository';
import type {
  RoleAssignmentRepository,
  RoleRepository,
  SellerMembershipRepository,
} from '../ports/seller-team.repository';
import type { ThrottleKeys } from '../ports/session-secrets';
import type { ThrottleRepository } from '../ports/throttle.repository';
import { countMailAttempt } from '../sign-up/mail-attempt';
import type { FieldProblem } from './register-customer.use-case';

export interface RegisterSellerInput {
  readonly displayName: string;
  readonly email: string;
  readonly password: string;
  /** The IPv4 address or the IPv6 /64 of the client, from the socket: the `mail.origin` key. */
  readonly origin: string;
}

/** The one answer for every address, new or known (AC 21; identity design 6.7, 8.6 row 1). */
export type RegisterSellerOutput = { readonly code: 'sign-up.accepted' };

export type RegisterSellerFailure =
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldProblem[] }
  | PasswordRejected
  | PasswordHasherBusy
  | { readonly code: 'access.unavailable' };

export interface RegisterSellerDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly sellerAccess: SellerAccessRepository;
  readonly memberships: SellerMembershipRepository;
  readonly roles: RoleRepository;
  readonly assignments: RoleAssignmentRepository;
  readonly links: OneTimeLinkRepository;
  readonly throttles: ThrottleRepository;
  readonly keys: ThrottleKeys;
  readonly outbox: OutboxWriter;
  readonly hasher: PasswordHasher;
  readonly commonPasswords: CommonPasswordList;
  readonly policy: IdentityMarketPolicy;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

const UNAVAILABLE = Object.freeze({ code: 'access.unavailable' as const });

/**
 * Seller self-registration (identity design 3.1, 3.3, 5.5, 6.7; SEL-01, SEL-03; slice 5). Rule
 * `anonymous`. The same steps and the same one answer as customer sign-up (`RegisterCustomer`):
 * the request's own checks, the hash before any read (HF12), the mail counters in a unit of
 * their own (L4), then one serializable unit (HF8: it writes `accounts`, `seller_memberships`
 * and `role_assignments`):
 *
 * - a new address: in one unit, the seller id is minted with its `SellerAccess` (`pending` when
 *   the Market requires approval, `approved` otherwise; SEL-03, AC 5) and its data key; the
 *   active, unverified seller account with its display name, credential and data key; the
 *   owner's membership; the founding assignment of the seller scope's system role (5.5: the
 *   creation of the scope, not a grant, so no audit row); and the `verify-email` link. No
 *   event but the link's: the seller is published at the owner's verification (8.2);
 * - an unverified seller account: password and name replaced, purge anchor restarted, a new
 *   link (`identity.sign-up-repeated.v1`, `unverified-replaced`); its seller stays as it is;
 * - a verified one: the "you already have an account" notice at most once per interval.
 *
 * The seller scope's system role is read in every branch, so a Market whose seed has not run
 * answers `access.unavailable` (503) whatever the address. A Market without seller sessions or
 * seller link pages offers no seller sign-up and answers the same. Personal data (email, name)
 * is never logged.
 */
export class RegisterSeller extends UseCase<
  RegisterSellerInput,
  RegisterSellerOutput,
  RegisterSellerFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.register-seller',
    rule: { kind: 'anonymous' },
  };

  readonly #logger = new Logger('RegisterSeller');

  constructor(
    gate: UseCaseGate,
    private readonly deps: RegisterSellerDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: RegisterSellerInput,
  ): Promise<Result<RegisterSellerOutput, RegisterSellerFailure>> {
    const { market } = context;
    const { policy, hasher } = this.deps;

    const fields: FieldProblem[] = [];
    const displayName = parseDisplayName(input.displayName);
    if (!displayName.ok) fields.push({ path: 'displayName', code: displayName.error.rule });
    const email = parseEmailAddress(input.email);
    if (!email.ok) fields.push({ path: 'email', code: 'format' });
    if (!displayName.ok || !email.ok) return err({ code: 'validation.failed', fields });
    if (
      policy.sessionLifetime(market, 'seller') === null ||
      policy.linkLifetimeMinutes(market, 'verify-email') === null
    ) {
      return err(UNAVAILABLE);
    }
    // 6.5: the password may contain neither the email nor the name.
    const checked = checkNewPassword(
      input.password,
      policy.passwordRules(market),
      { email: email.value.normalized, displayName: displayName.value },
      (comparable) => this.deps.commonPasswords.isCommon(comparable),
    );
    if (!checked.ok) return err(checked.error);

    // HF12: hashed before any read, outside every unit (platform persistence 3.1 row 5).
    const hashed = await hasher.hash(input.password);
    if (!hashed.ok) return err(hashed.error);

    const now = this.deps.clock.now();
    try {
      const mailAllowed = await countMailAttempt(
        this.deps,
        context,
        'seller',
        email.value.normalized,
        input.origin,
        now,
      );
      if (!mailAllowed) {
        this.#logger.log({
          msg: 'identity.register-seller.mail-throttled',
          marketId: market.marketId,
          correlationId: context.correlationId,
        });
      }
      const stored = await this.store(context, {
        email: email.value,
        displayName: displayName.value,
        passwordHash: hashed.value,
        now,
        mailAllowed,
      });
      if (!stored.ok) {
        if (stored.error === 'unavailable') {
          this.#logger.error({
            msg: 'identity.register-seller.system-role-missing',
            marketId: market.marketId,
            correlationId: context.correlationId,
          });
          return err(UNAVAILABLE);
        }
        if (stored.error === 'invalid') return err({ code: 'validation.failed', fields: [] });
      }
    } catch (error) {
      if (error instanceof TransactionConflictError) {
        this.#logger.warn({
          msg: 'identity.register-seller.conflict-retry',
          metric: 'conflict.retry',
          useCase: RegisterSeller.access.name,
          marketId: market.marketId,
          correlationId: context.correlationId,
        });
      }
      throw error;
    }
    return ok({ code: 'sign-up.accepted' });
  }

  /** The one serializable unit of every branch (HF8, HF12). */
  private async store(
    context: CallContext,
    request: {
      readonly email: EmailAddress;
      readonly displayName: string;
      readonly passwordHash: string;
      readonly now: Temporal.Instant;
      readonly mailAllowed: boolean;
    },
  ): Promise<Result<void, 'email-taken' | 'invalid' | 'unavailable'>> {
    const { market } = context;
    const { accounts, links, outbox, roles, ids, policy } = this.deps;
    const { email, displayName, passwordHash, now, mailAllowed } = request;
    return this.deps.unitOfWork.run(
      market,
      async (): Promise<Result<void, 'email-taken' | 'invalid' | 'unavailable'>> => {
        const ownerRole = await roles.findSystemRole(market, 'seller');
        if (ownerRole === null) return err('unavailable');
        const existing = await accounts.findByEmail(market, 'seller', email.normalized);
        if (existing === null) {
          const access = SellerAccess.forSelfRegistration({
            sellerId: ids.next<'Seller'>(),
            marketId: market.marketId,
            approvalRequired: policy.sellerApprovalRequired(market),
            now,
          });
          const account = Account.registerSeller({
            id: ids.next<'Account'>(),
            marketId: market.marketId,
            email,
            displayName,
            passwordHash,
            now,
          });
          await this.deps.sellerAccess.add(market, access);
          const added = await accounts.add(market, account);
          if (!added.ok) {
            // An error result rolls the unit back, the seller access and its key with it.
            return err(added.error.code === 'account.email-taken' ? 'email-taken' : 'invalid');
          }
          await this.deps.memberships.add(
            market,
            SellerMembership.found({
              id: ids.next<'SellerMembership'>(),
              marketId: market.marketId,
              accountId: account.state.id,
              sellerId: access.state.sellerId,
              now,
            }),
          );
          await this.deps.assignments.add(
            market,
            RoleAssignment.found({
              id: ids.next<'RoleAssignment'>(),
              account: account.state,
              role: ownerRole,
              now,
            }),
          );
          const link = OneTimeLink.request({
            id: ids.next<'OneTimeLink'>(),
            marketId: market.marketId,
            accountId: account.state.id,
            purpose: 'verify-email',
            now,
            notify: mailAllowed,
          });
          await links.add(market, link);
          await outbox.append(context, [...account.pendingEvents, ...link.pendingEvents]);
          return ok(undefined);
        }
        const outcome = existing.signUpAgain({
          passwordHash,
          displayName,
          now,
          noticeHours: policy.existingAccountNoticeHours(market),
          mailAllowed,
        });
        await accounts.save(market, existing);
        const events = [...existing.pendingEvents];
        if (outcome === 'unverified-replaced') {
          // 3.2: the older link is void; a new one is requested (no link for a disabled account).
          const notify = mailAllowed && existing.state.status === 'active';
          const found = await links.findFor(market, existing.state.id, 'verify-email');
          if (found === null) {
            const link = OneTimeLink.request({
              id: ids.next<'OneTimeLink'>(),
              marketId: market.marketId,
              accountId: existing.state.id,
              purpose: 'verify-email',
              now,
              notify,
            });
            await links.add(market, link);
            events.push(...link.pendingEvents);
          } else {
            found.requestAgain(now, notify);
            await links.save(market, found);
            events.push(...found.pendingEvents);
          }
        }
        if (events.length > 0) await outbox.append(context, events);
        return ok(undefined);
      },
      { isolation: 'serializable' },
    );
  }
}
