import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { ListRegisteredSellers } from '../application/use-cases/list-registered-sellers.use-case';
import type { NotifyAccessReviewers } from '../application/use-cases/notify-access-reviewers.use-case';
import type { SellerAccessOf } from '../application/use-cases/seller-access-of.use-case';
import type { SellerAccessOfSystem } from '../application/use-cases/seller-access-of-system.use-case';
import type {
  FacadeValidationFailed,
  RegisteredSellerPage,
  ReviewerNoticeOutcome,
  ReviewerNoticeUnavailable,
  SellerAccessContract,
  SellerAccessSummary,
} from '../contracts/seller-access.contract';

/** The use cases behind the seller-access contract (`sellerAccessOf` has a pair). */
export interface SellerAccessContractUseCases {
  readonly sellerAccessOf: SellerAccessOf;
  readonly sellerAccessOfSystem: SellerAccessOfSystem;
  readonly listRegisteredSellers: ListRegisteredSellers;
  readonly notifyAccessReviewers: NotifyAccessReviewers;
}

/**
 * The implementation of {@link SellerAccessContract} (identity design 8.1; ADR-0022 decision 6):
 * a class of its own, so the object other modules receive as `IDENTITY_FACADE` does not carry
 * these methods at all. Each method passes the caller's `CallContext` unchanged to one use
 * case through `execute`, so the gate runs.
 */
export class SellerAccessContractImplementation implements SellerAccessContract {
  constructor(private readonly useCases: SellerAccessContractUseCases) {}

  sellerAccessOf(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<Result<readonly SellerAccessSummary[], AccessDenied | FacadeValidationFailed>> {
    // The one decision of the contract: which of the pair (8.1). The gate still checks the rule.
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

  notifyAccessReviewers(
    context: CallContext,
    sellerId: Id<'Seller'>,
  ): Promise<
    Result<ReviewerNoticeOutcome, AccessDenied | FacadeValidationFailed | ReviewerNoticeUnavailable>
  > {
    return this.useCases.notifyAccessReviewers.execute(context, { sellerId });
  }
}
