import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { DescribeActor } from '../application/use-cases/describe-actor.use-case';
import type { ListRegisteredSellers } from '../application/use-cases/list-registered-sellers.use-case';
import type { MembershipOf } from '../application/use-cases/membership-of.use-case';
import type { SellerAccessOf } from '../application/use-cases/seller-access-of.use-case';
import type { SellerAccessOfSystem } from '../application/use-cases/seller-access-of-system.use-case';
import type {
  ActorDescription,
  FacadeValidationFailed,
  IdentityFacade,
  RegisteredSellerPage,
  SellerAccessSummary,
  SellerMembershipSummary,
} from '../contracts/identity.facade';

/** The use cases behind the facade, one per method (two for `sellerAccessOf`). */
export interface IdentityFacadeUseCases {
  readonly describeActor: DescribeActor;
  readonly membershipOf: MembershipOf;
  readonly sellerAccessOf: SellerAccessOf;
  readonly sellerAccessOfSystem: SellerAccessOfSystem;
  readonly listRegisteredSellers: ListRegisteredSellers;
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

  sellerAccessOf(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<Result<readonly SellerAccessSummary[], AccessDenied | FacadeValidationFailed>> {
    // The one decision of the facade: which of the pair (8.1). The gate still checks the rule.
    const useCase =
      context.actor.kind === 'system'
        ? this.useCases.sellerAccessOfSystem
        : this.useCases.sellerAccessOf;
    return useCase.execute(context, { sellerIds });
  }

  listRegisteredSellers(
    context: CallContext,
    page: { readonly after: Id<'Seller'> | null; readonly limit: number },
  ): Promise<Result<RegisteredSellerPage, AccessDenied | FacadeValidationFailed>> {
    return this.useCases.listRegisteredSellers.execute(context, page);
  }
}
