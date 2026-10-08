import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { DescribeActor } from '../application/use-cases/describe-actor.use-case';
import type { MembershipOf } from '../application/use-cases/membership-of.use-case';
import type { TeamMembershipOf } from '../application/use-cases/team-membership-of.use-case';
import type {
  ActorDescription,
  IdentityFacade,
  SellerMembershipSummary,
} from '../contracts/identity.facade';

/** The use cases behind the facade, one per method. */
export interface IdentityFacadeUseCases {
  readonly describeActor: DescribeActor;
  readonly membershipOf: MembershipOf;
  readonly teamMembershipOf: TeamMembershipOf;
}

/**
 * The implementation of {@link IdentityFacade} (identity design 8.1): each method passes the
 * caller's `CallContext` unchanged to one use case through `execute`, so the gate runs, and
 * returns ids and codes only: the name and the email of the HTTP summary are dropped here.
 */
export class IdentityFacadeImplementation implements IdentityFacade {
  constructor(private readonly useCases: IdentityFacadeUseCases) {}

  async describeActor(context: CallContext): Promise<Result<ActorDescription, AccessDenied>> {
    const result = await this.useCases.describeActor.execute(context, {});
    // A summary that vanished under a concurrent revocation is `access.denied`, as the gate's.
    if (!result.ok) return err(result.error);
    const summary = result.value;
    return ok({
      accountId: summary.accountId,
      population: summary.population,
      sellerId: summary.sellerId,
      roleId: summary.roleId,
      permissionKeys: summary.permissionKeys,
      sellerAccessState: summary.sellerAccessState,
      secondFactorActive: summary.secondFactorActive,
    });
  }

  /**
   * Two use cases behind one method (as `sellerAccessOf`): the actor's own id goes to
   * `identity.membership-of` (`own-resources`, allowed when not approved); any other id to
   * `identity.team-membership-of` (`identity.team-member.view`, slice 8a-1). Each runs the gate.
   */
  membershipOf(
    context: CallContext,
    accountId: Id<'Account'>,
  ): Promise<Result<SellerMembershipSummary, AccessDenied>> {
    const own = context.actor.kind === 'authenticated' && context.actor.accountId === accountId;
    return own
      ? this.useCases.membershipOf.execute(context, { accountId })
      : this.useCases.teamMembershipOf.execute(context, { accountId });
  }
}
