import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  UseCase,
  type AccessDeclaration,
  type SealedPermissionCatalogue,
  type UseCaseGate,
} from '../../../../platform/authz';
import { TEAM_MEMBER_ASSIGN_ROLE } from '../../contracts/permissions';
import { AccountRoleChangedAudit } from '../../domain/audit';
import { LastHolderPolicy } from '../../domain/last-holder-policy';
import { isSystemRole, mayActOnAdmin } from '../accounts/admin-verdicts';
import type { EffectiveKeyResolver } from '../access/effective-keys';
import type { AccountRepository } from '../ports/account.repository';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import type { SellerAccessRepository } from '../ports/seller-access.repository';
import type {
  RoleAssignmentRepository,
  RoleRepository,
  SellerMembershipRepository,
} from '../ports/seller-team.repository';
import { roleGrantVerdict, roleIsInActorsReach, type GrantSubject } from '../roles/granting';
import { isActiveMemberOf, readActingSellerGrants, sellerSubjectOf } from '../sellers/seller-team';

const RULE_KEYS = [TEAM_MEMBER_ASSIGN_ROLE.key];

export interface AssignTeamMemberRoleInput {
  readonly accountId: Id<'Account'>;
  readonly roleId: Id<'Role'>;
}

export interface AssignTeamMemberRoleOutput {
  /** `role.assigned`, or `role.unchanged` when the member already held the role. */
  readonly code: 'role.assigned' | 'role.unchanged';
  readonly accountId: Id<'Account'>;
  readonly roleId: Id<'Role'>;
}

export type AssignTeamMemberRoleFailure =
  /** No active member of the actor's seller with this id (another seller's too): "not found". */
  | { readonly code: 'account.unknown' }
  /** No seller role of this seller with this id (also another seller's role): "not found". */
  | { readonly code: 'role.unknown' }
  | { readonly code: 'member.self' }
  | { readonly code: 'member.outranks-actor' }
  | { readonly code: 'role.not-grantable' }
  | { readonly code: 'member.last-holder' }
  | { readonly code: 'access.denied' };

export interface AssignTeamMemberRoleDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly roles: RoleRepository;
  readonly memberships: SellerMembershipRepository;
  readonly sellerAccess: SellerAccessRepository;
  readonly assignments: RoleAssignmentRepository;
  readonly grants: RoleGrantReader;
  readonly effectiveKeys: EffectiveKeyResolver;
  readonly permissions: Pick<SealedPermissionCatalogue, 'get'>;
  readonly outbox: OutboxWriter;
  readonly audit: AuditWriter;
  readonly clock: Clock;
}

/**
 * Changes a team member's role (identity design 5.3 `identity.team-member.assign-role`, 5.4 R1,
 * R3 and R11, 5.5; AC 23, AC 25, AC 34; `ux.md` F11 step 4; slice 11, HF8). Rule `permissions
 * [identity.team-member.assign-role]` (protected: in Phase 2 the Seller Owner's alone), denied
 * while the seller is not approved. Everything else is decided here, in **one serializable
 * unit** (5.5, HF8), so of two concurrent demotions of the last two Seller Owners one is retried
 * and then refused:
 *
 * 0. The actor, read in this unit (`readActingSellerGrants`): still an active, verified member of
 *    its seller, which is still approved, holding the Seller Owner role and the rule's key.
 * 1. The target is an active member of the **actor's own seller** (R6: the seller is the actor's,
 *    never input); any other id, or a removed member, answers `account.unknown`, and a role that
 *    is not a seller role of this seller `role.unknown`, byte-identical to a missing one (5.2).
 * 2. The grants of the actor and the target are read in this unit (Hassan I-2).
 * 3. `GrantPolicy.canActOn` (not oneself: `member.self`; the target's keys a subset of the
 *    actor's, R1), R3 on a holder of the Seller Owner role (`member.outranks-actor`), and
 *    `LastHolderPolicy` when the target holds that role and would lose it (`member.last-holder`).
 * 4. `GrantPolicy.canGrant` on the new role (`role.not-grantable`): every key it confers is the
 *    actor's (R1), a protected key is never grantable in seller scope in Phase 2 (R11), and the
 *    Seller Owner role is never granted (HF5).
 * 5. The assignment changes under its version; `identity.account-role-changed.v1` and the audit
 *    row `identity.account-role.changed` (`before` and `after` role ids, R5).
 *
 * The same role answers `role.unchanged` and writes nothing. No session is revoked: permissions
 * are read on every request (R4, AC 26).
 */
export class AssignTeamMemberRole extends UseCase<
  AssignTeamMemberRoleInput,
  AssignTeamMemberRoleOutput,
  AssignTeamMemberRoleFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.assign-team-member-role',
    rule: { kind: 'permissions', allOf: [TEAM_MEMBER_ASSIGN_ROLE.key] },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('AssignTeamMemberRole');

  constructor(
    gate: UseCaseGate,
    private readonly deps: AssignTeamMemberRoleDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: AssignTeamMemberRoleInput,
  ): Promise<Result<AssignTeamMemberRoleOutput, AssignTeamMemberRoleFailure>> {
    const { market } = context;
    const self = sellerSubjectOf(context);
    if (self === null || self.sellerId === null) return err({ code: 'access.denied' });
    const sellerId = self.sellerId;
    const result = await this.deps.unitOfWork.run(
      market,
      async (): Promise<Result<AssignTeamMemberRoleOutput, AssignTeamMemberRoleFailure>> => {
        const now = this.deps.clock.now();
        const subject: GrantSubject = {
          accountId: input.accountId,
          population: 'seller',
          sellerId,
        };
        const reading = await readActingSellerGrants(this.deps, market, self, [subject], RULE_KEYS);
        if (reading === null) return err({ code: 'access.denied' });
        const target = await this.deps.accounts.findById(market, input.accountId);
        if (
          target === null ||
          target.state.population !== 'seller' ||
          !(await isActiveMemberOf(this.deps.memberships, market, input.accountId, sellerId))
        ) {
          return err({ code: 'account.unknown' });
        }
        const role = await this.deps.roles.findById(market, input.roleId);
        if (role === null || !roleIsInActorsReach(role, self)) {
          return err({ code: 'role.unknown' });
        }
        const assignment = await this.deps.assignments.findByAccount(market, input.accountId);
        if (assignment === null) {
          // Every member is created with its assignment (acceptance, 3.4); one without is a
          // corrupt store, answered as not found and logged, never repaired here.
          this.log('identity.assign-team-member-role.assignment-missing', context, {
            accountId: input.accountId,
          });
          return err({ code: 'account.unknown' });
        }
        const system = await this.deps.roles.findSystemRole(market, 'seller');
        const systemRoleId = system?.state.id ?? null;
        // canActOn, then R3 on the target: the target-dependent steps of the list's change-role
        // hint (`memberChangeVerdict`, which adds `LastHolderPolicy` below); change both together.
        const acted = mayActOnAdmin(
          reading.actor,
          reading.targets.get(input.accountId)!,
          assignment.state.roleId,
          systemRoleId,
        );
        if (!acted.ok) return err(acted.error);
        const granted = roleGrantVerdict(reading.actor, role, this.deps);
        if (!granted.ok) {
          this.log('identity.assign-team-member-role.not-grantable', context, {
            reason: granted.error.reason,
          });
          return err({ code: 'role.not-grantable' });
        }
        const previousRoleId = assignment.state.roleId;
        if (previousRoleId === role.state.id) {
          return ok({ code: 'role.unchanged', accountId: input.accountId, roleId: role.state.id });
        }
        // Losing the Seller Owner role: the active, verified owners are counted in this unit.
        if (isSystemRole(previousRoleId, systemRoleId)) {
          const holders = await this.deps.assignments.activeHoldersOfInSeller(
            market,
            systemRoleId!,
            sellerId,
          );
          const kept = LastHolderPolicy.allowsLosing(holders, input.accountId);
          if (!kept.ok) return err(kept.error);
        }
        assignment.reassign({
          account: {
            id: input.accountId,
            marketId: market.marketId,
            population: 'seller',
            sellerId,
          },
          role,
          assignedBy: self.accountId,
          now,
        });
        await this.deps.assignments.save(market, assignment);
        await this.deps.outbox.append(context, assignment.pendingEvents);
        await this.deps.audit.record(
          context,
          AccountRoleChangedAudit.entry(input.accountId, {
            before: { roleId: previousRoleId },
            after: { roleId: role.state.id, scope: 'seller', sellerId },
          }),
        );
        return ok({ code: 'role.assigned', accountId: input.accountId, roleId: role.state.id });
      },
      { isolation: 'serializable' },
    );
    this.log('identity.assign-team-member-role', context, {
      outcome: result.ok ? result.value.code : result.error.code,
      accountId: input.accountId,
      ...(result.ok ? { roleId: result.value.roleId } : {}),
    });
    return result;
  }

  /** Ids and codes only: never a name, an email or a role's name (R5). */
  private log(msg: string, context: CallContext, fields: Record<string, string>): void {
    this.#logger.log({
      msg,
      ...fields,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
}
