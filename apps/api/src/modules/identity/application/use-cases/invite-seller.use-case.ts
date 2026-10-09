import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, IdGenerator, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SELLER_ACCOUNT_CREATE } from '../../contracts/permissions';
import { InvitationIssuedAudit, InvitationRevokedAudit } from '../../domain/audit';
import { parseDisplayName } from '../../domain/display-name';
import { parseEmailAddress } from '../../domain/email-address';
import { Invitation } from '../../domain/invitation';
import { SellerAccess } from '../../domain/seller-access';
import type { EffectiveKeyResolver } from '../access/effective-keys';
import type { AccountRepository } from '../ports/account.repository';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import {
  InvitationAlreadyPendingError,
  type InvitationRepository,
} from '../ports/invitation.repository';
import type { LinkTargets } from '../ports/link-secrets';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import type { SellerAccessRepository } from '../ports/seller-access.repository';
import type { RoleRepository, SellerMembershipRepository } from '../ports/seller-team.repository';
import { readActingGrants, type GrantSubject } from '../roles/granting';
import type { FieldProblem } from './register-customer.use-case';

const RULE_KEYS = [SELLER_ACCOUNT_CREATE.key];

export interface InviteSellerInput {
  /** The invitee's address. Personal data: never logged or audited. */
  readonly email: string;
  /** The Seller Owner's name, kept at acceptance (`ux.md` D6). Personal data. */
  readonly displayName: string;
  /**
   * Absent or null: a new seller is created with the invitation. Set: a seller created earlier
   * whose access never had a member (HF5 (a)), for instance after its first invitation was
   * revoked or expired.
   */
  readonly sellerId?: Id<'Seller'> | null;
}

export interface InviteSellerOutput {
  readonly code: 'invitation.issued';
  readonly invitationId: Id<'Invitation'>;
  readonly sellerId: Id<'Seller'>;
  /** Whether a stale pending invitation of the seller was revoked first (M7, M12). */
  readonly replaced: boolean;
}

export type InviteSellerFailure =
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldProblem[] }
  /** The Market already has a seller-side account with this address (6.7). */
  | { readonly code: 'account.exists' }
  | { readonly code: 'invitation.already-pending' }
  /** The seller named is not one of this Market's: "not found". */
  | { readonly code: 'seller.unknown' }
  /** The seller named had a member once: a seller-owner invitation is for an empty seller (HF5). */
  | { readonly code: 'seller.has-members' }
  /**
   * The Market configures no seller-owner lifetime or acceptance page, or the role seed has not
   * run: no invitation could be sent or accepted.
   */
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'access.denied' };

export interface InviteSellerDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly roles: RoleRepository;
  readonly grants: RoleGrantReader;
  readonly effectiveKeys: EffectiveKeyResolver;
  readonly sellerAccess: SellerAccessRepository;
  readonly memberships: SellerMembershipRepository;
  readonly invitations: InvitationRepository;
  readonly targets: LinkTargets;
  readonly outbox: OutboxWriter;
  readonly audit: AuditWriter;
  readonly policy: IdentityMarketPolicy;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * An admin creates a seller by inviting its owner (identity design 3.3, 3.4 `seller-owner`;
 * SEL-06, AC 5, AC 31; `ux.md` D6, F9 step 6; slice 9). Rule
 * `permissions [identity.seller-account.create]`.
 *
 * Before any unit: the address and the name (the display-name rules, HF13), the kind's lifetime
 * and the seller panel's acceptance page; without either the Market cannot complete an
 * acceptance (`access.unavailable`, fail closed). One read-write unit at READ COMMITTED (it writes
 * `seller_access` and `invitations`, none of the tables C11 runs serializable):
 *
 * 1. The actor, still an active, verified admin holding the rule's key (`readActingGrants`).
 * 2. The seller system role of the Market (the role the owner receives at acceptance).
 * 3. An address that already has a seller-side account in the Market is `account.exists`: the
 *    acceptance could only fail ("sign in and join" is not in this slice).
 * 4. New seller: `SellerAccess.forInvitation`, `pending` when the Market requires approval, else
 *    `approved` (AC 5, AC 31), registered at once (`identity.seller-registered.v1`, no owner yet),
 *    with its subject key. An existing seller: of this Market, and its access never had a member
 *    (HF5 (a)); its pending seller-owner invitation, if any, is replaced when stale (M7) and is
 *    `invitation.already-pending` otherwise (M12).
 * 5. The invitation, without a token: `identity.invitation-issued.v1`, which the mail handler
 *    dispatches (E9); audit `identity.invitation.issued` (`seller-owner`) as the actor.
 *
 * The address and the name are never logged or audited.
 */
export class InviteSeller extends UseCase<
  InviteSellerInput,
  InviteSellerOutput,
  InviteSellerFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.invite-seller',
    rule: { kind: 'permissions', allOf: [SELLER_ACCOUNT_CREATE.key] },
  };

  readonly #logger = new Logger('InviteSeller');

  constructor(
    gate: UseCaseGate,
    private readonly deps: InviteSellerDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: InviteSellerInput,
  ): Promise<Result<InviteSellerOutput, InviteSellerFailure>> {
    const result = await this.issue(context, input);
    this.#logger.log({
      msg: 'identity.invite-seller',
      outcome: result.ok ? result.value.code : result.error.code,
      ...(result.ok
        ? {
            invitationId: result.value.invitationId,
            sellerId: result.value.sellerId,
            replaced: result.value.replaced,
          }
        : {}),
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  private async issue(
    context: CallContext,
    input: InviteSellerInput,
  ): Promise<Result<InviteSellerOutput, InviteSellerFailure>> {
    const { market, actor } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const fields: FieldProblem[] = [];
    const email = parseEmailAddress(input.email);
    if (!email.ok) fields.push({ path: 'email', code: 'format' });
    const displayName = parseDisplayName(input.displayName);
    if (!displayName.ok) fields.push({ path: 'displayName', code: displayName.error.rule });
    if (!email.ok || !displayName.ok) return err({ code: 'validation.failed', fields });
    const { policy, targets } = this.deps;
    const lifetime = policy.invitationLifetimeMinutes(market, 'seller-owner');
    if (lifetime === null || targets.target(market, 'seller', 'accept-invitation') === null) {
      return err({ code: 'access.unavailable' });
    }
    const self: GrantSubject = { accountId: actor.accountId, population: 'admin', sellerId: null };

    try {
      return await this.deps.unitOfWork.run(
        market,
        async (): Promise<Result<InviteSellerOutput, InviteSellerFailure>> => {
          const { sellerAccess, invitations, outbox, audit } = this.deps;
          const now = this.deps.clock.now();
          const reading = await readActingGrants(this.deps, market, self, [], RULE_KEYS);
          if (reading === null) return err({ code: 'access.denied' });
          const ownerRole = await this.deps.roles.findSystemRole(market, 'seller');
          if (ownerRole === null) return err({ code: 'access.unavailable' });
          const existing = await this.deps.accounts.findByEmail(
            market,
            'seller',
            email.value.normalized,
          );
          if (existing !== null) return err({ code: 'account.exists' });

          let sellerId: Id<'Seller'>;
          let replaced = false;
          if (input.sellerId === undefined || input.sellerId === null) {
            const access = SellerAccess.forInvitation({
              sellerId: this.deps.ids.next<'Seller'>(),
              marketId: market.marketId,
              approvalRequired: policy.sellerApprovalRequired(market),
              now,
            });
            await sellerAccess.add(market, access);
            await outbox.append(context, access.pendingEvents);
            sellerId = access.state.sellerId;
          } else {
            sellerId = input.sellerId;
            const access = await sellerAccess.findById(market, sellerId);
            if (access === null || !access.isRegistered) return err({ code: 'seller.unknown' });
            if (await this.deps.memberships.sellerHasMembers(market, sellerId)) {
              return err({ code: 'seller.has-members' });
            }
            const pending = await invitations.findPendingOwnerInvitation(market, sellerId);
            if (pending !== null) {
              if (!pending.replaceableAt(now, lifetime)) {
                return err({ code: 'invitation.already-pending' });
              }
              pending.revoke(now);
              await invitations.save(market, pending);
              await outbox.append(context, pending.pendingEvents);
              await audit.record(
                context,
                InvitationRevokedAudit.entry(pending.state.id, {
                  after: { kind: pending.state.kind, roleId: pending.state.roleId },
                }),
              );
              replaced = true;
            }
          }
          const invitation = Invitation.issue({
            id: this.deps.ids.next<'Invitation'>(),
            marketId: market.marketId,
            kind: 'seller-owner',
            email: email.value,
            displayName: displayName.value,
            roleId: ownerRole.state.id,
            sellerId,
            invitedByAccountId: actor.accountId,
            now,
          });
          await invitations.add(market, invitation);
          await outbox.append(context, invitation.pendingEvents);
          await audit.record(
            context,
            InvitationIssuedAudit.entry(invitation.state.id, {
              after: { kind: 'seller-owner', roleId: ownerRole.state.id },
            }),
          );
          return ok({
            code: 'invitation.issued',
            invitationId: invitation.state.id,
            sellerId,
            replaced,
          });
        },
      );
    } catch (error) {
      if (!(error instanceof InvitationAlreadyPendingError)) throw error;
      return err({ code: 'invitation.already-pending' });
    }
  }
}
