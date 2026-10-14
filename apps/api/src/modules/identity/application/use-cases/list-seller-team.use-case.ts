import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result, Temporal } from '@mondapac/shared-kernel';
import {
  UseCase,
  type AccessDeclaration,
  type SealedPermissionCatalogue,
  type UseCaseGate,
} from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  TEAM_MEMBER_ASSIGN_ROLE,
  TEAM_MEMBER_INVITE,
  TEAM_MEMBER_REMOVE,
  TEAM_MEMBER_VIEW,
} from '../../contracts/permissions';
import type { ActedOnAccount, GrantingActor } from '../../domain/grant-policy';
import { invitationStatusAt } from '../../domain/invitation';
import type { Role } from '../../domain/role';
import type { EffectiveKeyResolver } from '../access/effective-keys';
import type { AccountRepository } from '../ports/account.repository';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { InvitationRepository, PendingStaffInvitation } from '../ports/invitation.repository';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import type { SellerAccessRepository } from '../ports/seller-access.repository';
import type { SellerMemberSummary, SellerTeamReader } from '../ports/seller-team-reader';
import type {
  RoleAssignmentRepository,
  RoleRepository,
  SellerMembershipRepository,
} from '../ports/seller-team.repository';
import { readGrants, roleIsInActorsReach, type GrantSubject } from '../roles/granting';
import {
  memberChangeVerdict,
  readActingSellerMember,
  sellerSubjectOf,
  staffInvitationResendVerdict,
} from '../sellers/seller-team';
import type { ActionHint, AdminTeamRole } from './list-admin-team.use-case';

/** The largest page of the seller team list; the default page of the route is smaller. */
export const MAX_SELLER_TEAM_PAGE = 100;

export interface ListSellerTeamInput {
  /** The last id of the previous page; absent or null for the first page. */
  readonly after?: string | null;
  readonly limit: number;
}

export interface SellerTeamMemberRow {
  readonly type: 'account';
  readonly accountId: Id<'Account'>;
  readonly email: string;
  readonly displayName: string | null;
  /** The actor's own row ("You"). */
  readonly self: boolean;
  /** Null only for a member without an assignment (a corrupt store). */
  readonly role: AdminTeamRole | null;
  readonly actions: { readonly changeRole: ActionHint; readonly remove: ActionHint };
}

export interface SellerTeamInvitationRow {
  readonly type: 'invitation';
  readonly invitationId: Id<'Invitation'>;
  readonly email: string;
  /** Null when the role no longer exists (R12): the invitation cannot be accepted. */
  readonly role: AdminTeamRole | null;
  readonly invitedByAccountId: Id<'Account'> | null;
  /** `expired`: past the expiry of its last mail; it can be re-sent within its lifetime. */
  readonly status: 'pending' | 'expired';
  readonly createdAt: Temporal.Instant;
  /** Null until its mail is sent (and right after a re-send). */
  readonly expiresAt: Temporal.Instant | null;
  readonly actions: { readonly resend: ActionHint; readonly revoke: ActionHint };
}

export type SellerTeamRow = SellerTeamMemberRow | SellerTeamInvitationRow;

export interface SellerTeamPage {
  /** Active members and pending Staff invitations, merged by id (UUID v7: creation order). */
  readonly items: readonly SellerTeamRow[];
  /** The `after` of the next page, or null when this page was the last. */
  readonly next: string | null;
}

export type ListSellerTeamFailure =
  | { readonly code: 'access.denied' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface ListSellerTeamDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly sellerTeam: SellerTeamReader;
  readonly invitations: InvitationRepository;
  readonly roles: RoleRepository;
  readonly memberships: SellerMembershipRepository;
  readonly sellerAccess: SellerAccessRepository;
  readonly assignments: RoleAssignmentRepository;
  readonly grants: RoleGrantReader;
  readonly effectiveKeys: EffectiveKeyResolver;
  readonly permissions: Pick<SealedPermissionCatalogue, 'get'>;
  readonly policy: IdentityMarketPolicy;
  readonly clock: Clock;
}

const ALLOWED: ActionHint = Object.freeze({ allowed: true, code: null });
const denied = (code: string): ActionHint => Object.freeze({ allowed: false, code });
const hintOf = (result: Result<unknown, { readonly code: string }>): ActionHint =>
  result.ok ? ALLOWED : denied(result.error.code);

/**
 * The seller team list (identity design 5.3 `identity.team-member.view`, 8.6 rows 2 and 6;
 * `ux.md` B1 and F11; slice 11): the active members of the actor's own seller with their roles,
 * and its pending Staff invitations, each row with an `allowed` flag and a denial code per
 * action. Rule `permissions [identity.team-member.view]`, denied while the seller is not
 * approved. The seller is the actor's (R6): no parameter names one, so another seller's team is
 * unreachable. One read-only unit (ADR-0025), so the rows and their hints are not one snapshot;
 * they are hints only.
 *
 * **Hints (no second implementation).** Change role and remove run `memberChangeVerdict`, the
 * target-dependent verdict the two commands run too (`GrantPolicy.canActOn`, R3, and
 * `LastHolderPolicy` for the Seller Owner role); re-send runs `staffInvitationResendVerdict`;
 * revoke needs only its key. An action whose key the actor lacks is `access.denied` and nothing
 * else is evaluated or read for it, so a Staff member with the view key only sees every action
 * disabled, and no hint tells more than the command would answer the same actor. Whether a given
 * role is grantable is the role catalogue's `grantable` (`identity.list-seller-roles`).
 *
 * Never in an answer: a token or its hash, a credential, a factor's secret.
 */
export class ListSellerTeam extends UseCase<
  ListSellerTeamInput,
  SellerTeamPage,
  ListSellerTeamFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.list-seller-team',
    rule: { kind: 'permissions', allOf: [TEAM_MEMBER_VIEW.key] },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('ListSellerTeam');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ListSellerTeamDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ListSellerTeamInput,
  ): Promise<Result<SellerTeamPage, ListSellerTeamFailure>> {
    const result = await this.list(context, input);
    this.#logger.log({
      msg: 'identity.list-seller-team',
      outcome: result.ok ? 'seller-team.listed' : result.error.code,
      ...(result.ok ? { rows: result.value.items.length, more: result.value.next !== null } : {}),
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  private async list(
    context: CallContext,
    input: ListSellerTeamInput,
  ): Promise<Result<SellerTeamPage, ListSellerTeamFailure>> {
    const { market } = context;
    const self = sellerSubjectOf(context);
    if (self === null || self.sellerId === null) return err({ code: 'access.denied' });
    const sellerId = self.sellerId;
    const { limit } = input;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SELLER_TEAM_PAGE) {
      return err({ code: 'validation.failed', fields: [{ path: 'limit', code: 'range' }] });
    }
    let after: string | null = null;
    if (input.after !== undefined && input.after !== null) {
      const parsed = parseId(input.after);
      if (!parsed.ok) {
        return err({ code: 'validation.failed', fields: [{ path: 'after', code: 'format' }] });
      }
      after = parsed.value;
    }
    const lifetime = this.deps.policy.invitationLifetimeMinutes(market, 'staff');
    return this.deps.unitOfWork.run(
      market,
      async (): Promise<Result<SellerTeamPage, ListSellerTeamFailure>> => {
        const now = this.deps.clock.now();
        // The actor first, read in this unit as the commands read it: an active, verified
        // member of its seller, which is approved, holding the view key; else the whole list is
        // refused before any row, and so any personal data, is read.
        const acting = await readActingSellerMember(
          this.deps,
          market,
          self,
          [],
          [TEAM_MEMBER_VIEW.key],
        );
        if (acting === null) return err({ code: 'access.denied' });
        // One row more of each than the page tells whether another page exists.
        const members = await this.deps.sellerTeam.activeMembers(
          market,
          sellerId,
          after as Id<'Account'> | null,
          limit + 1,
        );
        const invitations = await this.deps.invitations.pendingStaffInvitations(
          market,
          sellerId,
          after as Id<'Invitation'> | null,
          limit + 1,
        );
        const merged: PageEntry[] = [
          ...members.map((row) => ({ id: row.accountId, member: row })),
          ...invitations.map((row) => ({ id: row.id, invitation: row })),
        ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const page = merged.slice(0, limit);
        const pageMembers = page.flatMap((row) => ('member' in row ? [row.member] : []));
        const subjects: GrantSubject[] = pageMembers.map((row) => ({
          accountId: row.accountId,
          population: 'seller',
          sellerId,
        }));
        // The effective keys of the page's members, by the one resolver (`canActOn` reads them).
        const targets =
          (await readGrants(this.deps.grants, this.deps.effectiveKeys, market, self, subjects))
            ?.targets ?? new Map<Id<'Account'>, ActedOnAccount>();
        const rows = await new RowBuilder(
          this.deps,
          context,
          acting.actor,
          self,
          now,
          lifetime,
          targets,
        ).build(page, pageMembers);
        const more = merged.length > limit;
        return ok({ items: rows, next: more ? page[page.length - 1]!.id : null });
      },
      { readOnly: true },
    );
  }
}

type PageEntry =
  | { readonly id: string; readonly member: SellerMemberSummary }
  | { readonly id: string; readonly invitation: PendingStaffInvitation };

/** Builds the rows of one page and their hints, reading what a hint needs once per page. */
class RowBuilder {
  readonly #roles = new Map<string, Promise<Role | null>>();
  #holders: Promise<readonly Id<'Account'>[]> | null = null;

  constructor(
    private readonly deps: ListSellerTeamDependencies,
    private readonly context: CallContext,
    private readonly actor: GrantingActor,
    private readonly self: GrantSubject,
    private readonly now: Temporal.Instant,
    private readonly lifetime: number | null,
    private readonly targets: ReadonlyMap<Id<'Account'>, ActedOnAccount>,
  ) {}

  private holds(key: string): boolean {
    return this.actor.effectiveKeys.has(key);
  }

  private role(roleId: Id<'Role'>): Promise<Role | null> {
    let found = this.#roles.get(roleId);
    if (found === undefined) {
      found = this.deps.roles.findById(this.context.market, roleId);
      this.#roles.set(roleId, found);
    }
    return found;
  }

  /** The active, verified Seller Owners: read once, and only when a hint asks. */
  private holders(systemRoleId: Id<'Role'>): Promise<readonly Id<'Account'>[]> {
    this.#holders ??= this.deps.assignments.activeHoldersOfInSeller(
      this.context.market,
      systemRoleId,
      this.self.sellerId!,
    );
    return this.#holders;
  }

  private shown(role: Role | null): AdminTeamRole | null {
    // A role out of this seller's reach is never one of its members' (R2, R9); shown as none.
    if (role === null || !roleIsInActorsReach(role, this.self)) return null;
    return {
      roleId: role.state.id,
      kind: role.state.kind,
      seedCode: role.state.seedCode,
      name: role.state.kind === 'custom' ? (role.state.name ?? null) : null,
    };
  }

  async build(
    page: readonly PageEntry[],
    pageMembers: readonly SellerMemberSummary[],
  ): Promise<SellerTeamRow[]> {
    const { market } = this.context;
    const grants = await this.deps.grants.grantsOf(
      market,
      pageMembers.map((row) => row.accountId),
    );
    const systemRoleId = (await this.deps.roles.findSystemRole(market, 'seller'))?.state.id ?? null;
    const rows: SellerTeamRow[] = [];
    for (const entry of page) {
      if ('member' in entry) {
        const roleId = grants.get(entry.member.accountId)?.roleId ?? null;
        rows.push(await this.memberRow(entry.member, roleId, systemRoleId));
      } else {
        rows.push(await this.invitationRow(entry.invitation));
      }
    }
    return rows;
  }

  private async memberRow(
    member: SellerMemberSummary,
    roleId: Id<'Role'> | null,
    systemRoleId: Id<'Role'> | null,
  ): Promise<SellerTeamMemberRow> {
    const target = this.targets.get(member.accountId)!;
    const verdict = async (key: string): Promise<ActionHint> =>
      this.holds(key)
        ? hintOf(
            await memberChangeVerdict({
              actor: this.actor,
              target,
              targetRoleId: roleId,
              systemRoleId,
              holders: () => this.holders(systemRoleId!),
            }),
          )
        : denied('access.denied');
    const changeRole = await verdict(TEAM_MEMBER_ASSIGN_ROLE.key);
    return {
      type: 'account',
      accountId: member.accountId,
      email: member.email,
      displayName: member.displayName,
      self: member.accountId === this.actor.accountId,
      role: roleId === null ? null : this.shown(await this.role(roleId)),
      actions: {
        // Mirror of `AssignTeamMemberRole`'s target steps; a member without an assignment cannot
        // change role (`account.unknown`). Whether a given role is grantable is not a row hint.
        changeRole: roleId === null && changeRole.allowed ? denied('account.unknown') : changeRole,
        remove: await verdict(TEAM_MEMBER_REMOVE.key),
      },
    };
  }

  private async invitationRow(
    invitation: PendingStaffInvitation,
  ): Promise<SellerTeamInvitationRow> {
    const role = await this.role(invitation.roleId);
    return {
      type: 'invitation',
      invitationId: invitation.id,
      email: invitation.email,
      role: this.shown(role),
      invitedByAccountId: invitation.invitedByAccountId,
      status: invitationStatusAt(invitation, this.now) === 'expired' ? 'expired' : 'pending',
      createdAt: invitation.createdAt,
      expiresAt: invitation.expiresAt,
      actions: {
        resend: await this.resendHint(invitation),
        revoke: this.holds(TEAM_MEMBER_INVITE.key) ? ALLOWED : denied('access.denied'),
      },
    };
  }

  private async resendHint(invitation: PendingStaffInvitation): Promise<ActionHint> {
    if (!this.holds(TEAM_MEMBER_INVITE.key)) return denied('access.denied');
    if (this.lifetime === null) return denied('access.unavailable');
    const verdict = await staffInvitationResendVerdict(
      this.deps,
      this.context.market,
      { self: this.self, view: this.actor },
      { ...invitation, sellerId: this.self.sellerId },
      this.now,
      this.lifetime,
    );
    return verdict.ok ? ALLOWED : denied(verdict.error.code);
  }
}
