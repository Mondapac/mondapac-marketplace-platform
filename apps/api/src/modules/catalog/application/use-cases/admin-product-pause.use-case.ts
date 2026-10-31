import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_PRODUCT_PAUSE } from '../../contracts/permissions';
import { ProductPausedAudit, scopeCode } from '../../domain/audit';
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

export interface AdminProductPauseInput {
  readonly productId: unknown;
}

export interface AdminProductPauseOutput {
  readonly productId: string;
  /** Offers of the product that are not deleted and now carry the cause `product-paused`. */
  readonly offerCount: number;
}

export type AdminProductPauseFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'product.not-found' }
  | { readonly code: LifecycleRefusal }
  | typeof RETRY_EXHAUSTED;

/**
 * `admin-product.pause` (catalog design 4.1a, 8.2): an admin takes a published product, and every
 * Offer on it, off sale until it is resumed. Rule: the key `catalog.product.pause` and the admin
 * population. In one unit, product row first: the product gets the mark `pausedAt` and the event
 * `catalog.product-paused.v1`; every Offer that is not deleted gets the stored cause
 * `product-paused` (a listed Offer goes off sale: `catalog.offer-listing-changed.v1`, once, and a
 * `causes-changed` history row); one audit row. Only a `published` product that is not paused; any
 * other is refused (`product.not-published`, `product.already-paused`). Another Market's id and
 * an unknown one are the same `product.not-found`. A lost race asks again, at most three times.
 */
export class AdminProductPause extends UseCase<
  AdminProductPauseInput,
  AdminProductPauseOutput,
  AdminProductPauseFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.admin-product-pause',
    rule: { kind: 'permissions', allOf: [CATALOG_PRODUCT_PAUSE.key] },
  };

  readonly #logger = new Logger('AdminProductPause');

  constructor(
    gate: UseCaseGate,
    private readonly deps: LifecycleDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: AdminProductPauseInput,
  ): Promise<Result<AdminProductPauseOutput, AdminProductPauseFailure>> {
    const result = await this.#pause(context, input);
    this.#logger.log({
      msg: 'catalog.admin-product-pause',
      code: result.ok ? 'paused' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #pause(
    context: CallContext,
    input: AdminProductPauseInput,
  ): Promise<Result<AdminProductPauseOutput, AdminProductPauseFailure>> {
    const admin = adminOf(context);
    if (admin === null) return err({ code: 'access.denied' });
    const productId = productIdOf(input.productId);
    if (productId === null) return err({ code: 'product.not-found' });
    const { market } = context;
    const { deps } = this;
    const outcome = await withRetry<
      AdminProductPauseOutput,
      { readonly code: 'product.not-found' } | { readonly code: LifecycleRefusal }
    >(async () => {
      const written = await deps.unitOfWork.run<
        AdminProductPauseOutput,
        { readonly code: 'product.not-found' } | { readonly code: LifecycleRefusal }
      >(
        market,
        async () => {
          const product = await deps.products.findById(market, productId);
          if (product === null) return err({ code: 'product.not-found' as const });
          const now = deps.clock.now();
          const paused = product.pause({ accountId: admin.accountId, now });
          if (!paused.ok) return err(lifecycleRefusal(paused.error));
          await deps.products.save(market, product);
          await deps.outbox.append(context, product.pendingEvents);
          const offers = await offersOfProduct(deps.offers, market, productId);
          for (const offer of offers) {
            offer.changeCauses({ add: ['product-paused'], now });
            await saveOffer(deps, context, offer, admin.accountId);
          }
          await deps.audit.record(
            context,
            ProductPausedAudit.entry(productId, {
              before: { paused: false },
              after: {
                paused: true,
                scope: scopeCode(product.state.scope),
                offerCount: offers.length,
              },
            }),
          );
          return ok({ productId, offerCount: offers.length });
        },
        { timeoutMs: LIFECYCLE_TIMEOUT_MS },
      );
      return written;
    });
    if (outcome.ok) return outcome;
    return err(outcome.error);
  }
}
