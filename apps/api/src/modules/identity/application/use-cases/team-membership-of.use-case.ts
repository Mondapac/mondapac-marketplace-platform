import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { TEAM_MEMBER_VIEW } from '../../contracts/permissions';
import type {
  RoleAssignmentRepository,
  SellerMembershipRepository,
} from '../ports/seller-team.repository';
import type { Membership, MembershipOfFailure, MembershipOfInput } from './membership-of.use-case';

export interface TeamMembershipOfDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly memberships: SellerMembershipRepository;
  readonly assignments: RoleAssignmentRepository;
}

/**
 * `membershipOf` for another account (identity design 8.1; slice 8a-1, decided by Ali; ADR-0018
 * decision 6): the active membership of an account **of the actor's own team**, with its role.
 * Rule `permissions [identity.team-member.view]` (seller scope), denied while the seller is not
 * approved: the team page is not on the allow-list (5.2, flow F).
 *
 * Ownership stays here (R6): the seller comes from `ActorContext`, never from input, and an
 * account that is not an active member of that seller (another seller's member, an account of
 * another Market, an unknown id, a removed member) answers `null`, exactly as an account with no
 * membership does, so the answer tells nothing about other sellers (Hassan, 14.2). One read-only
 * unit. The facade sends the actor's own id to `identity.membership-of` instead.
 */
export class TeamMembershipOf extends UseCase<MembershipOfInput, Membership, MembershipOfFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.team-membership-of',
    rule: { kind: 'permissions', allOf: [TEAM_MEMBER_VIEW.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: TeamMembershipOfDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: MembershipOfInput,
  ): Promise<Result<Membership, MembershipOfFailure>> {
    const { market, actor } = context;
    if (
      actor.kind !== 'authenticated' ||
      actor.population !== 'seller' ||
      actor.sellerId === null
    ) {
      return err({ code: 'access.denied' });
    }
    const sellerId = actor.sellerId;
    const read = await this.deps.unitOfWork.run(
      market,
      async () => {
        const membership = await this.deps.memberships.findActiveByAccount(market, input.accountId);
        if (membership === null || membership.state.sellerId !== sellerId) return ok(null);
        const assignment = await this.deps.assignments.findByAccount(market, input.accountId);
        return ok({ sellerId, roleId: assignment?.state.roleId ?? null });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.denied' });
    return ok(read.value);
  }
}
