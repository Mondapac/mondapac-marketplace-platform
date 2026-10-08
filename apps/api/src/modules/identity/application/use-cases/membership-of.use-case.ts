import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type {
  RoleAssignmentRepository,
  SellerMembershipRepository,
} from '../ports/seller-team.repository';

export interface MembershipOfInput {
  readonly accountId: Id<'Account'>;
}

/** The seller the account works for and its role (8.1), or none. Ids only. */
export type Membership = {
  readonly sellerId: Id<'Seller'>;
  readonly roleId: Id<'Role'> | null;
} | null;

export type MembershipOfFailure = { readonly code: 'access.denied' };

export interface MembershipOfDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly memberships: SellerMembershipRepository;
  readonly assignments: RoleAssignmentRepository;
}

/**
 * `membershipOf` (identity design 8.1; slice 5): the active membership of an account, with its
 * role. Rule `own-resources`, allowed when the seller is not approved, **for oneself only**: an
 * account id other than the actor's is `access.denied`, whoever asks (R6). The variant for
 * other accounts is `TeamMembershipOf`, under `identity.team-member.view` (slice 8a-1); the
 * facade chooses between the two by the id. One read-only unit.
 */
export class MembershipOf extends UseCase<MembershipOfInput, Membership, MembershipOfFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.membership-of',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: MembershipOfDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: MembershipOfInput,
  ): Promise<Result<Membership, MembershipOfFailure>> {
    const { market, actor } = context;
    // R6: the input id is checked against the actor, never trusted.
    if (actor.kind !== 'authenticated' || input.accountId !== actor.accountId) {
      return err({ code: 'access.denied' });
    }
    const read = await this.deps.unitOfWork.run(
      market,
      async () => {
        const membership = await this.deps.memberships.findActiveByAccount(market, actor.accountId);
        if (membership === null) return ok(null);
        const assignment = await this.deps.assignments.findByAccount(market, actor.accountId);
        return ok({
          sellerId: membership.state.sellerId,
          roleId: assignment?.state.roleId ?? null,
        });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.denied' });
    return ok(read.value);
  }
}
