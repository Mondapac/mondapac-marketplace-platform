import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { DescribeActor } from '../application/use-cases/describe-actor.use-case';
import type { ActorDescription, IdentityFacade } from '../contracts/identity.facade';

/**
 * The implementation of {@link IdentityFacade} (identity design 8.1): each method passes the
 * caller's `CallContext` unchanged to one use case through `execute`, so the gate runs, and
 * returns ids and codes only: the name and the email of the HTTP summary are dropped here.
 */
export class IdentityFacadeImplementation implements IdentityFacade {
  constructor(private readonly describe: DescribeActor) {}

  async describeActor(context: CallContext): Promise<Result<ActorDescription, AccessDenied>> {
    const result = await this.describe.execute(context, {});
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
}
