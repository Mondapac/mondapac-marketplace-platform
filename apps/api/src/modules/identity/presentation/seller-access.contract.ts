import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { ApproveSellerAccess } from '../application/use-cases/approve-seller-access.use-case';
import type { FindAccessDecisionsByBasis } from '../application/use-cases/find-access-decisions-by-basis.use-case';
import type { ListSellerAccessDecisions } from '../application/use-cases/list-seller-access-decisions.use-case';
import type { ReapplySellerAccess } from '../application/use-cases/reapply-seller-access.use-case';
import type { RejectSellerAccess } from '../application/use-cases/reject-seller-access.use-case';
import type { ListRegisteredSellers } from '../application/use-cases/list-registered-sellers.use-case';
import type { NotifyAccessReviewers } from '../application/use-cases/notify-access-reviewers.use-case';
import type { SellerAccessOf } from '../application/use-cases/seller-access-of.use-case';
import type { SellerAccessOfSystem } from '../application/use-cases/seller-access-of-system.use-case';
import type {
  AccessDecisionByBasis,
  AccessDecisionsUnavailable,
  FacadeValidationFailed,
  RegisteredSellerPage,
  ReviewerNoticeOutcome,
  ReviewerNoticeUnavailable,
  SellerAccessContract,
  SellerAccessDecisionHistory,
  SellerAccessDecisionOutcome,
  SellerAccessDecisionRefusal,
  SellerAccessSummary,
  SellerReapplyOutcome,
  SellerReapplyRefusal,
} from '../contracts/seller-access.contract';

/** The use cases behind the seller-access contract (`sellerAccessOf` has a pair). */
export interface SellerAccessContractUseCases {
  readonly sellerAccessOf: SellerAccessOf;
  readonly sellerAccessOfSystem: SellerAccessOfSystem;
  readonly listRegisteredSellers: ListRegisteredSellers;
  readonly notifyAccessReviewers: NotifyAccessReviewers;
  readonly approveSellerAccess: ApproveSellerAccess;
  readonly rejectSellerAccess: RejectSellerAccess;
  readonly reapplySellerAccess: ReapplySellerAccess;
  readonly listSellerAccessDecisions: ListSellerAccessDecisions;
  readonly findAccessDecisionsByBasis: FindAccessDecisionsByBasis;
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

  async approveSellerAccess(
    context: CallContext,
    sellerId: Id<'Seller'>,
    basisId: Id,
  ): Promise<Result<SellerAccessDecisionOutcome, AccessDenied | SellerAccessDecisionRefusal>> {
    const result = await this.useCases.approveSellerAccess.execute(context, { sellerId, basisId });
    return result.ok ? ok(decisionOutcome(result.value, 'seller-access.approved')) : result;
  }

  async rejectSellerAccess(
    context: CallContext,
    sellerId: Id<'Seller'>,
    reason: string,
    basisId: Id,
  ): Promise<Result<SellerAccessDecisionOutcome, AccessDenied | SellerAccessDecisionRefusal>> {
    const result = await this.useCases.rejectSellerAccess.execute(context, {
      sellerId,
      reason,
      basisId,
    });
    return result.ok ? ok(decisionOutcome(result.value, 'seller-access.rejected')) : result;
  }

  reapplySellerAccess(
    context: CallContext,
    sellerId: Id<'Seller'>,
  ): Promise<Result<SellerReapplyOutcome, AccessDenied | SellerReapplyRefusal>> {
    return this.useCases.reapplySellerAccess.execute(context, { sellerId });
  }

  accessDecisionsOf(
    context: CallContext,
    sellerId: Id<'Seller'>,
  ): Promise<
    Result<
      SellerAccessDecisionHistory,
      AccessDenied | FacadeValidationFailed | AccessDecisionsUnavailable
    >
  > {
    return this.useCases.listSellerAccessDecisions.execute(context, { sellerId });
  }

  accessDecisionsByBasis(
    context: CallContext,
    items: readonly { readonly sellerId: Id<'Seller'>; readonly basisId: Id }[],
  ): Promise<
    Result<
      readonly AccessDecisionByBasis[],
      AccessDenied | FacadeValidationFailed | AccessDecisionsUnavailable
    >
  > {
    return this.useCases.findAccessDecisionsByBasis.execute(context, { items });
  }
}

/** The contract's answer to a decision: ids and codes, never the reason or the session count. */
function decisionOutcome(
  value: Pick<SellerAccessDecisionOutcome, 'sellerId' | 'state' | 'decisionId'>,
  code: SellerAccessDecisionOutcome['code'],
): SellerAccessDecisionOutcome {
  return { code, sellerId: value.sellerId, state: value.state, decisionId: value.decisionId };
}
