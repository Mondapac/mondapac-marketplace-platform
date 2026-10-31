import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_PRODUCT_DELETE } from '../../contracts/permissions';
import { ProductWithdrawnAudit, scopeCode } from '../../domain/audit';
import {
  adminOf,
  LIFECYCLE_TIMEOUT_MS,
  lifecycleRefusal,
  offersOfProduct,
  productIdOf,
  saveOffer,
  withRetry,
  type LifecycleDependencies,
  type LifecycleRefusal,
  type RETRY_EXHAUSTED,
} from '../products/product-lifecycle';

export interface AdminProductWithdrawInput {
  readonly productId: unknown;
}

export interface AdminProductWithdrawOutput {
  readonly productId: string;
  /** Offers of the product that were deleted with it. */
  readonly offerCount: number;
}

export type AdminProductWithdrawFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'product.not-found' }
  | { readonly code: LifecycleRefusal }
  | typeof RETRY_EXHAUSTED;

/**
 * `admin-product.withdraw` (catalog design 4.1, 8.2): an admin withdraws a SELLER product
 * (`unpublished`, or `published` whether paused or not). Terminal; PLATFORM products are retired
 * instead (`product.seller-only`). Rule: the key `catalog.product.delete` and the admin
 * population. In one unit, product row first: the product becomes `withdrawn`, its pending
 * revision is set aside, the pause mark clears, `catalog.product-withdrawn.v1`; then every Offer
 * that is not deleted becomes `deleted` (tags `removed`, `catalog.offer-deleted.v1`, no
 * `evaluateClaims`, ADR-0028 d5); one audit row. Revisions are kept (VER-06).
 */
export class AdminProductWithdraw extends UseCase<
  AdminProductWithdrawInput,
  AdminProductWithdrawOutput,
  AdminProductWithdrawFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.admin-product-withdraw',
    rule: { kind: 'permissions', allOf: [CATALOG_PRODUCT_DELETE.key] },
  };

  readonly #logger = new Logger('AdminProductWithdraw');

  constructor(
    gate: UseCaseGate,
    private readonly deps: LifecycleDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: AdminProductWithdrawInput,
  ): Promise<Result<AdminProductWithdrawOutput, AdminProductWithdrawFailure>> {
    const result = await this.#withdraw(context, input);
    this.#logger.log({
      msg: 'catalog.admin-product-withdraw',
      code: result.ok ? 'withdrawn' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #withdraw(
    context: CallContext,
    input: AdminProductWithdrawInput,
  ): Promise<Result<AdminProductWithdrawOutput, AdminProductWithdrawFailure>> {
    const admin = adminOf(context);
    if (admin === null) return err({ code: 'access.denied' });
    const productId = productIdOf(input.productId);
    if (productId === null) return err({ code: 'product.not-found' });
    const { market } = context;
    const { deps } = this;
    type Refused = { readonly code: 'product.not-found' } | { readonly code: LifecycleRefusal };
    const outcome = await withRetry<AdminProductWithdrawOutput, Refused>(() =>
      deps.unitOfWork.run<AdminProductWithdrawOutput, Refused>(
        market,
        async () => {
          const product = await deps.products.findById(market, productId);
          if (product === null) return err({ code: 'product.not-found' as const });
          const before = product.state.status;
          const now = deps.clock.now();
          const withdrawn = product.withdraw({ now });
          if (!withdrawn.ok) return err(lifecycleRefusal(withdrawn.error));
          await deps.products.save(market, product);
          await deps.outbox.append(context, product.pendingEvents);
          const offers = await offersOfProduct(deps.offers, market, productId);
          for (const offer of offers) {
            offer.delete({ now, actor: { kind: 'admin', accountId: admin.accountId } });
            await saveOffer(deps, context, offer, admin.accountId);
          }
          await deps.audit.record(
            context,
            ProductWithdrawnAudit.entry(productId, {
              before: { status: before as 'unpublished' | 'published' },
              after: {
                status: 'withdrawn',
                scope: scopeCode(product.state.scope),
                offerCount: offers.length,
              },
            }),
          );
          return ok({ productId, offerCount: offers.length });
        },
        { timeoutMs: LIFECYCLE_TIMEOUT_MS },
      ),
    );
    return outcome.ok ? outcome : err(outcome.error);
  }
}
