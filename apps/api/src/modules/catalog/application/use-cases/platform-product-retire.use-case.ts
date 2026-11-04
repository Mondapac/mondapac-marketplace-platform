import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_PLATFORM_PRODUCT_RETIRE } from '../../contracts/permissions';
import { ProductRetiredAudit, scopeCode } from '../../domain/audit';
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

export interface PlatformProductRetireInput {
  readonly productId: unknown;
  /** The number of affected Offers the page showed (brief s4 f 3); a whole number, 0 or more. */
  readonly confirmOfferCount: unknown;
}

export interface PlatformProductRetireOutput {
  readonly productId: string;
  readonly offerCount: number;
}

export type PlatformProductRetireFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'product.not-found' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { path: string; code: string }[];
    }
  /** The count in the unit differs from the confirmed one: confirm again with `currentCount`. */
  | { readonly code: 'retire.count-changed'; readonly currentCount: number }
  | { readonly code: LifecycleRefusal }
  | typeof RETRY_EXHAUSTED;

/**
 * `platform-product.retire` (catalog design 4.1, 8.2; CAT-48): an admin retires a PLATFORM
 * product that is `published` (paused or not). Terminal. Rule: the protected key
 * `catalog.platform-product.retire` and the admin population. The request carries the affected
 * Offer count (Offers not deleted, any seller) the page showed; when the count read in the unit
 * differs, nothing changes and the answer is `retire.count-changed` with the current count, so
 * the admin confirms again. In one unit, product row first: the product becomes `retired`
 * (the pause mark clears) with `catalog.product-retired.v1`; every Offer gets the stored cause
 * `product-retired` and loses `product-paused`, if it had it (a swap, so no Offer is listed in
 * between and no `evaluateClaims` is asked, ADR-0028 d5); one audit row with both counts.
 * A SELLER product is withdrawn instead (`product.platform-only`).
 */
export class PlatformProductRetire extends UseCase<
  PlatformProductRetireInput,
  PlatformProductRetireOutput,
  PlatformProductRetireFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.platform-product-retire',
    rule: { kind: 'permissions', allOf: [CATALOG_PLATFORM_PRODUCT_RETIRE.key] },
  };

  readonly #logger = new Logger('PlatformProductRetire');

  constructor(
    gate: UseCaseGate,
    private readonly deps: LifecycleDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: PlatformProductRetireInput,
  ): Promise<Result<PlatformProductRetireOutput, PlatformProductRetireFailure>> {
    const result = await this.#retire(context, input);
    this.#logger.log({
      msg: 'catalog.platform-product-retire',
      code: result.ok ? 'retired' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #retire(
    context: CallContext,
    input: PlatformProductRetireInput,
  ): Promise<Result<PlatformProductRetireOutput, PlatformProductRetireFailure>> {
    const admin = adminOf(context);
    if (admin === null) return err({ code: 'access.denied' });
    const productId = productIdOf(input.productId);
    if (productId === null) return err({ code: 'product.not-found' });
    const confirmed = input.confirmOfferCount;
    if (typeof confirmed !== 'number' || !Number.isSafeInteger(confirmed) || confirmed < 0) {
      return err({
        code: 'validation.failed',
        fields: [{ path: 'confirmOfferCount', code: 'range' }],
      });
    }
    const { market } = context;
    const { deps } = this;
    type Refused =
      | { readonly code: 'product.not-found' }
      | { readonly code: 'retire.count-changed'; readonly currentCount: number }
      | { readonly code: LifecycleRefusal };
    const outcome = await withRetry<PlatformProductRetireOutput, Refused>(() =>
      deps.unitOfWork.run<PlatformProductRetireOutput, Refused>(
        market,
        async () => {
          const product = await deps.products.findById(market, productId);
          if (product === null) return err({ code: 'product.not-found' as const });
          const wasPaused = product.state.pausedAt !== null;
          const now = deps.clock.now();
          const retired = product.retire({ now });
          if (!retired.ok) return err(lifecycleRefusal(retired.error));
          const offers = await offersOfProduct(deps.offers, market, productId);
          if (offers.length !== confirmed) {
            return err({ code: 'retire.count-changed' as const, currentCount: offers.length });
          }
          await deps.products.save(market, product);
          await deps.outbox.append(context, product.pendingEvents);
          for (const offer of offers) {
            offer.changeCauses({ add: ['product-retired'], clear: ['product-paused'], now });
            await saveOffer(deps, context, offer, admin.accountId);
          }
          await deps.audit.record(
            context,
            ProductRetiredAudit.entry(productId, {
              before: { status: 'published', paused: wasPaused },
              after: {
                status: 'retired',
                scope: scopeCode(product.state.scope),
                offerCount: offers.length,
                confirmedOfferCount: confirmed,
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
