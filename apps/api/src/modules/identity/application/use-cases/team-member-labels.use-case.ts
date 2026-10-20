import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { Role } from '../../domain/role';
import type { EffectiveKeyResolver } from '../access/effective-keys';
import type { AccountRepository } from '../ports/account.repository';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import type { RoleRepository, SellerMembershipRepository } from '../ports/seller-team.repository';
import { readActingGrants, roleIsInActorsReach, type GrantSubject } from '../roles/granting';
import type { AdminTeamRole } from './list-admin-team.use-case';

/** The most ids one call may name: one page of a history the panel shows. */
export const MAX_TEAM_MEMBER_LABEL_IDS = 100;

export interface TeamMemberLabelsInput {
  /** As the caller passed them; parsed here, and never echoed when one does not parse. */
  readonly accountIds: readonly string[];
}

/**
 * One current member of the actor's own team, as a history row names who did something: the
 * display name and the role, never the sign-in address. PERSONAL DATA for the member who asked:
 * never logged, stored, cached or put in an event, an audit row or an error body.
 */
export interface TeamMemberLabelView {
  readonly accountId: Id<'Account'>;
  readonly displayName: string | null;
  /** Null for a member without an assignment, or whose role is out of this seller's reach. */
  readonly role: AdminTeamRole | null;
}

export type TeamMemberLabelsFailure =
  | { readonly code: 'access.denied' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface TeamMemberLabelsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly memberships: SellerMembershipRepository;
  readonly roles: RoleRepository;
  readonly grants: RoleGrantReader;
  readonly effectiveKeys: EffectiveKeyResolver;
}

const USE_CASE = 'identity.team-member-labels';

/**
 * `teamMemberLabels` (sellers' minimum-order history, seller operations P-E): who, among the ids a
 * module read from its own records, is a current member of the actor's own team, with name and
 * role. Rule `own-resources`, denied while the seller is not approved: any active member may see
 * who in their own shop changed a setting they can read. The seller is the actor's (R6): an
 * account that is not an active member of that seller (a removed member, another seller's member,
 * an admin, another Market's account, an unknown id) is absent, exactly alike, so the answer tells
 * nothing about other sellers. The actor is read again in this unit (an active, verified member)
 * before any other account. Refused with `access.denied`: a non-seller actor (the system actor by
 * the gate). Never over HTTP.
 *
 * Up to 100 ids, duplicates answered once; a malformed id is skipped (counted in the log, never
 * echoed). One read-only unit, no audit row. The log line carries counts, never a name.
 */
export class TeamMemberLabels extends UseCase<
  TeamMemberLabelsInput,
  readonly TeamMemberLabelView[],
  TeamMemberLabelsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: USE_CASE,
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('TeamMemberLabels');

  constructor(
    gate: UseCaseGate,
    private readonly deps: TeamMemberLabelsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: TeamMemberLabelsInput,
  ): Promise<Result<readonly TeamMemberLabelView[], TeamMemberLabelsFailure>> {
    const { actor, market } = context;
    let skipped = 0;
    const result = await this.read(context, input, () => (skipped += 1));
    this.#logger.log({
      msg: USE_CASE,
      outcome: result.ok ? 'team-member-labels.read' : result.error.code,
      ...(result.ok ? { rows: result.value.length } : {}),
      ...(skipped > 0 ? { malformedIds: skipped } : {}),
      ...(actor.kind === 'authenticated' ? { accountId: actor.accountId } : {}),
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  private async read(
    context: CallContext,
    input: TeamMemberLabelsInput,
    skip: () => void,
  ): Promise<Result<readonly TeamMemberLabelView[], TeamMemberLabelsFailure>> {
    const { market, actor } = context;
    if (
      actor.kind !== 'authenticated' ||
      actor.population !== 'seller' ||
      actor.sellerId === null
    ) {
      return err({ code: 'access.denied' });
    }
    const raw = input?.accountIds as unknown;
    if (!Array.isArray(raw) || raw.length > MAX_TEAM_MEMBER_LABEL_IDS) {
      return err({ code: 'validation.failed', fields: [{ path: 'accountIds', code: 'length' }] });
    }
    const ids = new Set<Id<'Account'>>();
    for (const value of raw as readonly unknown[]) {
      const parsed = typeof value === 'string' ? parseId<'Account'>(value) : null;
      if (parsed === null || !parsed.ok) skip();
      else ids.add(parsed.value);
    }
    if (ids.size === 0) return ok([]);
    const sellerId = actor.sellerId;
    const self: GrantSubject = { accountId: actor.accountId, population: 'seller', sellerId };
    return this.deps.unitOfWork.run(
      market,
      async (): Promise<Result<readonly TeamMemberLabelView[], TeamMemberLabelsFailure>> => {
        // The actor again, in this read, before any other account is loaded.
        if ((await readActingGrants(this.deps, market, self, [], [])) === null) {
          return err({ code: 'access.denied' });
        }
        const members: Id<'Account'>[] = [];
        for (const accountId of ids) {
          const membership = await this.deps.memberships.findActiveByAccount(market, accountId);
          if (membership !== null && membership.state.sellerId === sellerId) {
            members.push(accountId);
          }
        }
        if (members.length === 0) return ok([]);
        const grants = await this.deps.grants.grantsOf(market, members);
        const roles = new Map<Id<'Role'>, Promise<Role | null>>();
        const roleOf = (roleId: Id<'Role'>) => {
          let found = roles.get(roleId);
          if (found === undefined) {
            found = this.deps.roles.findById(market, roleId);
            roles.set(roleId, found);
          }
          return found;
        };
        const labels: TeamMemberLabelView[] = [];
        for (const accountId of members) {
          const account = await this.deps.accounts.findById(market, accountId);
          if (account === null || account.state.population !== 'seller') continue;
          const roleId = grants.get(accountId)?.roleId ?? null;
          const role = roleId === null ? null : await roleOf(roleId);
          labels.push({
            accountId,
            displayName: account.state.displayName,
            role: role === null || !roleIsInActorsReach(role, self) ? null : shownRole(role),
          });
        }
        return ok(labels);
      },
      { readOnly: true },
    );
  }
}

function shownRole(role: Role): AdminTeamRole {
  return {
    roleId: role.state.id,
    kind: role.state.kind,
    seedCode: role.state.seedCode,
    name: role.state.kind === 'custom' ? (role.state.name ?? null) : null,
  };
}
