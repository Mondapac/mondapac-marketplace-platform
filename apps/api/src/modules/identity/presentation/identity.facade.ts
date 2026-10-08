import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { DescribeActor } from '../application/use-cases/describe-actor.use-case';
import type { MembershipOf } from '../application/use-cases/membership-of.use-case';
import type {
  ActorDescription,
  IdentityFacade,
  SellerMembershipSummary,
} from '../contracts/identity.facade';

/** The use cases behind the facade, one per method. */
export interface IdentityFacadeUseCases {
  readonly describeActor: DescribeActor;
  readonly membershipOf: MembershipOf;
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

  membershipOf(
    context: CallContext,
    accountId: Id<'Account'>,
  ): Promise<Result<SellerMembershipSummary, AccessDenied>> {
    return this.useCases.membershipOf.execute(context, { accountId });
  }
}
