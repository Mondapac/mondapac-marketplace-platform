import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { TEAM_MEMBER_REMOVE } from '../../contracts/permissions';
import { SellerMemberRemovedAudit } from '../../domain/audit';
import type { EffectiveKeyResolver } from '../access/effective-keys';
import type { AccountRepository } from '../ports/account.repository';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import type { SellerAccessRepository } from '../ports/seller-access.repository';
import type {
  RoleAssignmentRepository,
  RoleRepository,
  SellerMembershipRepository,
} from '../ports/seller-team.repository';
import type { SessionRepository } from '../ports/session.repository';
import type { SignInChallengeRepository } from '../ports/sign-in-challenge.repository';
import type { GrantSubject } from '../roles/granting';
import {
  memberChangeVerdict,
  readActingSellerGrants,
  sellerSubjectOf,
} from '../sellers/seller-team';

const RULE_KEYS = [TEAM_MEMBER_REMOVE.key];

export interface RemoveTeamMemberInput {
  readonly accountId: Id<'Account'>;
}

export interface RemoveTeamMemberOutput {
  readonly code: 'member.removed';
  readonly accountId: Id<'Account'>;
  /** Sessions revoked with the removal. */
  readonly revokedSessions: number;
}

export type RemoveTeamMemberFailure =
  /** No active member of the actor's seller with this id (another seller's too): "not found". */
  | { readonly code: 'account.unknown' }
  | { readonly code: 'member.self' }
  | { readonly code: 'member.outranks-actor' }
  | { readonly code: 'member.last-holder' }
  | { readonly code: 'access.denied' };

export interface RemoveTeamMemberDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly roles: RoleRepository;
  readonly memberships: SellerMembershipRepository;
  readonly sellerAccess: SellerAccessRepository;
  readonly assignments: RoleAssignmentRepository;
  readonly grants: RoleGrantReader;
  readonly effectiveKeys: EffectiveKeyResolver;
  readonly sessions: SessionRepository;
  readonly challenges: SignInChallengeRepository;
  readonly outbox: OutboxWriter;
  readonly audit: AuditWriter;
  readonly clock: Clock;
}

/**
 * Removes a member from the seller's team (identity design 2.1 `SellerMembership` `active` →
 * `removed`, 5.4 R1, R3 and R4, 5.5; `ux.md` F11 step 5; slice 11, HF8). Rule `permissions
 * [identity.team-member.remove]` (protected: the Seller Owner's alone in Phase 2), denied while
 * the seller is not approved. The account itself stays (it keeps its own sign-in and may accept
 * another invitation, "Sign in and join", 6.7); it loses its place on this team. In **one
 * serializable unit** (5.5, HF8: every writer of `seller_memberships.state` and
 * `role_assignments`):
 *
 * 1. The account's credential lock first (`AccountRepository.lockCredential`), the lock the
 *    seller sign-in's closing unit takes before it re-checks the membership, so a sign-in racing
 *    the removal either commits its session first, and it is revoked here, or reads the removed
 *    membership and refuses. Then the actor (`readActingSellerGrants`): still an active, verified
 *    member of its seller, which is still approved, holding the Seller Owner role and the key.
 * 2. The target is an active member of the **actor's own seller** (R6); any other id, or an
 *    already removed member, answers `account.unknown`, byte-identical to a missing one (5.2).
 * 3. `memberChangeVerdict`, the one verdict of this command and of the team list's hint:
 *    `GrantPolicy.canActOn` (never oneself, `member.self`; never a member holding a key the actor
 *    lacks, R1), R3 on a holder of the Seller Owner role (`member.outranks-actor`), and
 *    `LastHolderPolicy` for the Seller Owner role (`member.last-holder`, AC 25), counted in this
 *    unit.
 * 4. The membership ends under its version, its role assignment is deleted, **every session of
 *    the account is revoked** (`membership-removed`) and **every open challenge voided**, in the
 *    same unit (R4: "their sessions end at once"). `identity.seller-member-removed.v1` and the
 *    audit row `identity.seller-member.removed` (`before` the role id; ids only).
 */
export class RemoveTeamMember extends UseCase<
  RemoveTeamMemberInput,
  RemoveTeamMemberOutput,
  RemoveTeamMemberFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.remove-team-member',
    rule: { kind: 'permissions', allOf: [TEAM_MEMBER_REMOVE.key] },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('RemoveTeamMember');

  constructor(
    gate: UseCaseGate,
    private readonly deps: RemoveTeamMemberDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: RemoveTeamMemberInput,
  ): Promise<Result<RemoveTeamMemberOutput, RemoveTeamMemberFailure>> {
    const { market } = context;
    const self = sellerSubjectOf(context);
    if (self === null || self.sellerId === null) return err({ code: 'access.denied' });
    const sellerId = self.sellerId;
    const result = await this.deps.unitOfWork.run(
      market,
      async (): Promise<Result<RemoveTeamMemberOutput, RemoveTeamMemberFailure>> => {
        const now = this.deps.clock.now();
        if (!(await this.deps.accounts.lockCredential(market, input.accountId))) {
          return err({ code: 'account.unknown' });
        }
        const subject: GrantSubject = {
          accountId: input.accountId,
          population: 'seller',
          sellerId,
        };
        const reading = await readActingSellerGrants(this.deps, market, self, [subject], RULE_KEYS);
        if (reading === null) return err({ code: 'access.denied' });
        const target = await this.deps.accounts.findById(market, input.accountId);
        const membership = await this.deps.memberships.findActiveByAccount(market, input.accountId);
        if (
          target === null ||
          target.state.population !== 'seller' ||
          membership === null ||
          membership.state.sellerId !== sellerId
        ) {
          return err({ code: 'account.unknown' });
        }
        const assignment = await this.deps.assignments.findByAccount(market, input.accountId);
        const systemRoleId =
          (await this.deps.roles.findSystemRole(market, 'seller'))?.state.id ?? null;
        const verdict = await memberChangeVerdict({
          actor: reading.actor,
          target: reading.targets.get(input.accountId)!,
          targetRoleId: assignment?.state.roleId ?? null,
          systemRoleId,
          holders: () =>
            this.deps.assignments.activeHoldersOfInSeller(market, systemRoleId!, sellerId),
        });
        if (!verdict.ok) return err(verdict.error);
        membership.end(now);
        await this.deps.memberships.save(market, membership);
        // Every member is created with its assignment; one without is a corrupt store, and the
        // removal still ends the membership.
        if (assignment !== null) await this.deps.assignments.remove(market, assignment);
        const revokedSessions = await this.deps.sessions.revokeAllOf(
          market,
          input.accountId,
          'membership-removed',
          now,
          null,
        );
        await this.deps.challenges.voidAllOf(market, input.accountId);
        await this.deps.outbox.append(context, membership.pendingEvents);
        // Always audited, even for a member stored without an assignment (Hassan L1).
        await this.deps.audit.record(
          context,
          SellerMemberRemovedAudit.entry(input.accountId, {
            before: { roleId: assignment?.state.roleId ?? null },
            after: { sellerId },
          }),
        );
        return ok({ code: 'member.removed', accountId: input.accountId, revokedSessions });
      },
      { isolation: 'serializable' },
    );
    this.#logger.log({
      msg: 'identity.remove-team-member',
      outcome: result.ok ? result.value.code : result.error.code,
      accountId: input.accountId,
      ...(result.ok ? { revokedSessions: result.value.revokedSessions } : {}),
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }
}
