import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type {
  CallContext,
  Clock,
  Id,
  IdGenerator,
  Result,
  Temporal,
} from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { Account } from '../../domain/account';
import {
  accountRoleAssigned,
  InvitationAcceptedAudit,
  SellerMemberAdded,
} from '../../domain/audit';
import type { Invitation } from '../../domain/invitation';
import {
  checkNewPassword,
  MAX_PASSWORD_BYTES,
  type PasswordRejected,
} from '../../domain/password-policy';
import { RoleAssignment } from '../../domain/role';
import { SellerMembership } from '../../domain/seller-membership';
import { reservationVerdict } from '../../domain/throttle';
import type { EffectiveKeyResolver } from '../access/effective-keys';
import type { AccountRepository } from '../ports/account.repository';
import type { CommonPasswordList } from '../ports/common-password-list';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { InvitationRepository } from '../ports/invitation.repository';
import type { PasswordHasher, PasswordHasherBusy } from '../ports/password-hasher';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import type { OpaqueTokens } from '../ports/second-factor-tokens';
import type { SellerAccessRepository } from '../ports/seller-access.repository';
import type {
  RoleAssignmentRepository,
  RoleRepository,
  SellerMembershipRepository,
} from '../ports/seller-team.repository';
import type { ThrottleKeys } from '../ports/session-secrets';
import type { ThrottleCounter, ThrottleRepository } from '../ports/throttle.repository';
import { sellerInviterStillStands } from '../sellers/seller-owner-invitation';
import type { SignInClient } from '../sign-in/sign-in-flow';
import type { FieldProblem } from './register-customer.use-case';

export interface AcceptSellerInvitationInput {
  readonly token: string;
  readonly password: string;
  readonly client: SignInClient;
}

/** The Seller Owner's account exists; no session is opened (identity design 3.4). */
export interface AcceptSellerInvitationOutput {
  readonly code: 'invitation.accepted';
}

export type AcceptSellerInvitationFailure =
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldProblem[] }
  | { readonly code: 'invitation.rejected' }
  | PasswordRejected
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  | PasswordHasherBusy
  | { readonly code: 'access.unavailable' };

export interface AcceptSellerInvitationDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly invitations: InvitationRepository;
  readonly roles: RoleRepository;
  readonly assignments: RoleAssignmentRepository;
  readonly memberships: SellerMembershipRepository;
  readonly sellerAccess: SellerAccessRepository;
  readonly grants: RoleGrantReader;
  readonly effectiveKeys: EffectiveKeyResolver;
  readonly throttles: ThrottleRepository;
  readonly keys: ThrottleKeys;
  readonly invitationTokens: OpaqueTokens;
  readonly hasher: PasswordHasher;
  readonly commonPasswords: CommonPasswordList;
  readonly outbox: OutboxWriter;
  readonly audit: AuditWriter;
  readonly policy: IdentityMarketPolicy;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

const REJECTED = Object.freeze({ code: 'invitation.rejected' as const });
const UNAVAILABLE = Object.freeze({ code: 'access.unavailable' as const });

/** Whether an invitation can be accepted as a seller owner's at `now`. */
function acceptableOwnerInvitation(
  invitation: Invitation | null,
  now: Temporal.Instant,
): invitation is Invitation {
  return (
    invitation !== null &&
    invitation.usableAt(now) &&
    invitation.state.kind === 'seller-owner' &&
    invitation.state.email !== null &&
    invitation.state.displayName !== null &&
    invitation.state.sellerId !== null
  );
}

/**
 * The invited Seller Owner accepts (identity design 3.4 `pending` → `accepted`; SEL-06, AC 29,
 * AC 31; `ux.md` F8; slice 9). Rule `anonymous`: the invitation's token binds the request. The
 * invitee chooses a password; the name is the one the admin gave (`ux.md` D6) and the address is
 * the invited one.
 *
 * 1. **Reservation unit**: `sign-in.origin` counted, the invitation read by the hash of its token;
 *    one that is unknown, of another kind or Market, used, revoked or expired answers
 *    `invitation.rejected` and stays counted; a usable one gives the count back.
 * 2. Outside any unit: the password's rules against the address and the name (HF13), then its
 *    hash (6.5).
 * 3. **Closing unit**, SERIALIZABLE (C11: it writes `accounts`, `seller_memberships` and
 *    `role_assignments`): the invitation read again and still acceptable; its role read again,
 *    still the seller system role of this Market (I-6); the seller's access of this Market, which
 *    never had a member (HF5 (a)); the inviter still an active, verified admin holding
 *    `identity.seller-account.create` (Hassan 14.2). Then the account `active` and verified with
 *    the invited address and the given name (its data key with it; an address that already has a
 *    seller-side account refuses, 6.7), the founding membership and the founding assignment of the
 *    seller system role (5.5: the creation of the scope, not a grant under R3), the invitation
 *    accepted (its address and name cleared). Event `identity.invitation-accepted.v1` (it names
 *    the seller and the owner's account). Audit rows, `ANONYMOUS` bound to the invitation:
 *    `identity.invitation.accepted`, `identity.seller-member.added` and
 *    `identity.account-role.assigned` (seller scope, `founding`). No session opens: the owner
 *    signs in (`ux.md` F8 step 3).
 *
 * Every refusal of the closing unit is `invitation.rejected` (one answer for every cause). The
 * token, the password, the address and the name are never logged.
 */
export class AcceptSellerInvitation extends UseCase<
  AcceptSellerInvitationInput,
  AcceptSellerInvitationOutput,
  AcceptSellerInvitationFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.accept-seller-invitation',
    rule: { kind: 'anonymous' },
  };

  readonly #logger = new Logger('AcceptSellerInvitation');

  constructor(
    gate: UseCaseGate,
    private readonly deps: AcceptSellerInvitationDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: AcceptSellerInvitationInput,
  ): Promise<Result<AcceptSellerInvitationOutput, AcceptSellerInvitationFailure>> {
    const result = await this.accept(context, input);
    this.log('identity.accept-seller-invitation', context, {
      outcome: result.ok ? result.value.code : result.error.code,
    });
    return result;
  }

  private async accept(
    context: CallContext,
    input: AcceptSellerInvitationInput,
  ): Promise<Result<AcceptSellerInvitationOutput, AcceptSellerInvitationFailure>> {
    const { market } = context;
    const { unitOfWork, throttles, keys, policy } = this.deps;
    if (
      typeof input.password !== 'string' ||
      Buffer.byteLength(input.password, 'utf8') > MAX_PASSWORD_BYTES
    ) {
      return err({ code: 'validation.failed', fields: [{ path: 'password', code: 'length' }] });
    }
    const tokenHash = this.deps.invitationTokens.hashOf(input.token);
    const origin: ThrottleCounter = {
      kind: 'sign-in.origin',
      keyHash: keys.origin(market, input.client.origin),
      accountKey: null,
      rule: policy.signInThrottles(market).origin,
    };

    // 1. The reservation unit.
    type Reserved =
      | { readonly kind: 'refused'; readonly refusal: AcceptSellerInvitationFailure }
      | {
          readonly kind: 'reserved';
          readonly invitationId: Id<'Invitation'>;
          readonly email: string;
          readonly displayName: string;
        };
    let reserved: Reserved;
    try {
      const run = await unitOfWork.run(market, async (): Promise<Result<Reserved, never>> => {
        const now = this.deps.clock.now();
        const [reservation] = await throttles.reserve(market, [origin], now);
        const verdict = reservationVerdict([{ reservation: reservation!, rule: origin.rule }], now);
        if (!verdict.allowed) {
          return ok({
            kind: 'refused',
            refusal: { code: 'request.throttled', retryAfterSeconds: verdict.retryAfterSeconds },
          });
        }
        const invitation =
          tokenHash === null
            ? null
            : await this.deps.invitations.findByTokenHash(market, tokenHash);
        if (!acceptableOwnerInvitation(invitation, now)) {
          return ok({ kind: 'refused', refusal: REJECTED });
        }
        await throttles.release(market, [reservation!]);
        return ok({
          kind: 'reserved',
          invitationId: invitation.state.id,
          email: invitation.state.email!.normalized,
          displayName: invitation.state.displayName!,
        });
      });
      if (!run.ok) return err(UNAVAILABLE);
      reserved = run.value;
    } catch {
      this.log('identity.accept-seller-invitation.unavailable', context, {});
      return err(UNAVAILABLE);
    }
    if (reserved.kind === 'refused') return err(reserved.refusal);
    const { invitationId } = reserved;

    // 2. Outside any unit: the password's rules, then its hash.
    const checked = checkNewPassword(
      input.password,
      policy.passwordRules(market),
      { email: reserved.email, displayName: reserved.displayName },
      (comparable) => this.deps.commonPasswords.isCommon(comparable),
    );
    if (!checked.ok) return err(checked.error);
    const hashed = await this.deps.hasher.hash(input.password);
    if (!hashed.ok) return err(hashed.error);

    // 3. The closing unit.
    const closed = await unitOfWork.run(
      market,
      async (): Promise<Result<Id<'Account'> | null, never>> => {
        const now = this.deps.clock.now();
        const invitation = await this.deps.invitations.findById(market, invitationId);
        if (!acceptableOwnerInvitation(invitation, now)) return ok(null);
        const sellerId = invitation.state.sellerId!;
        const role = await this.deps.roles.findById(market, invitation.state.roleId);
        if (role === null || role.state.scope !== 'seller' || !role.isSystem) return ok(null);
        const access = await this.deps.sellerAccess.findById(market, sellerId);
        if (access === null || (await this.deps.memberships.sellerHasMembers(market, sellerId))) {
          return ok(null);
        }
        if (
          !(await sellerInviterStillStands(this.deps, market, invitation.state.invitedByAccountId))
        ) {
          this.log('identity.accept-seller-invitation.inviter-refused', context, { invitationId });
          return ok(null);
        }
        // 6.7: an address that already has a seller-side account is refused here, before the
        // insert, so the unit never meets the unique key ("sign in and join" is not in slice 9).
        const email = invitation.state.email!;
        if ((await this.deps.accounts.findByEmail(market, 'seller', email.normalized)) !== null) {
          return ok(null);
        }
        const account = Account.acceptInvitation({
          id: this.deps.ids.next<'Account'>(),
          marketId: market.marketId,
          population: 'seller',
          email,
          displayName: invitation.state.displayName!,
          passwordHash: hashed.value,
          now,
        });
        const added = await this.deps.accounts.add(market, account);
        if (!added.ok) return ok(null);
        const accountId = account.state.id;
        await this.deps.memberships.add(
          market,
          SellerMembership.found({
            id: this.deps.ids.next<'SellerMembership'>(),
            marketId: market.marketId,
            accountId,
            sellerId,
            now,
          }),
        );
        await this.deps.assignments.add(
          market,
          RoleAssignment.found({
            id: this.deps.ids.next<'RoleAssignment'>(),
            account: { id: accountId, marketId: market.marketId, population: 'seller', sellerId },
            role,
            now,
          }),
        );
        if (!invitation.accept(accountId, now).ok) {
          throw new Error('AcceptSellerInvitation: an acceptable invitation refused acceptance');
        }
        await this.deps.invitations.save(market, invitation);
        await this.deps.outbox.append(context, invitation.pendingEvents);
        const roleId = role.state.id;
        const bound = { accountId, boundSubjectId: invitationId };
        await this.deps.audit.record(
          context,
          InvitationAcceptedAudit.entry(invitationId, {
            after: { kind: 'seller-owner', roleId, ...bound },
          }),
        );
        await this.deps.audit.record(
          context,
          SellerMemberAdded.entry(sellerId, {
            after: { sellerId, roleId, founding: true, ...bound },
          }),
        );
        await this.deps.audit.record(
          context,
          accountRoleAssigned(accountId, {
            ...bound,
            sellerId,
            roleId,
            scope: 'seller',
            founding: true,
          }),
        );
        return ok(accountId);
      },
      { isolation: 'serializable' },
    );
    if (!closed.ok || closed.value === null) return err(REJECTED);
    this.log('identity.accept-seller-invitation.accepted', context, {
      invitationId,
      accountId: closed.value,
    });
    return ok({ code: 'invitation.accepted' });
  }

  /** Ids and codes only: never the token, the password, the name or the address. */
  private log(msg: string, context: CallContext, fields: Record<string, string>): void {
    this.#logger.log({
      msg,
      ...fields,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
}
