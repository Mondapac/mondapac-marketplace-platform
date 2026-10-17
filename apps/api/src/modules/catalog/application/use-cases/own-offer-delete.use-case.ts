import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_EDIT } from '../../contracts/permissions';
import type { OfferRepository } from '../ports/offer.repository';
import type { ProductRepository } from '../ports/product.repository';

export interface OwnOfferDeleteInput {
  readonly offerId: string;
}

export type OwnOfferDeleteFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'offer.not-found' }
  /** The Offer belongs to the seller's own product: the product is withdrawn, not the Offer. */
  | { readonly code: 'offer.delete-via-product' }
  | { readonly code: 'conflict.stale' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface OwnOfferDeleteDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly offers: OfferRepository;
  readonly products: ProductRepository;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
}

/**
 * `own-offer.delete` (catalog design 4.4, OFR-06): a seller deletes their own Offer on a PLATFORM
 * product. The Offer becomes `deleted` (a status, never a row delete, Q-K2), stops being listed,
 * and `catalog.offer-deleted.v1` tells pricing and inventory. Rule: the key
 * `catalog.own-product.edit` and the seller population; the gate refuses a seller who is not
 * approved, and deleting reads no other eligibility. An Offer of another seller, a deleted one and
 * an unknown id are one byte-identical `offer.not-found`. An Offer on the seller's own SELLER
 * product is refused (`offer.delete-via-product`): there the product is withdrawn and the Offer
 * goes with it (design 4.1), which `own-product.delete` will do.
 */
export class OwnOfferDelete extends UseCase<
  OwnOfferDeleteInput,
  Record<string, never>,
  OwnOfferDeleteFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-offer-delete',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_EDIT.key] },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('OwnOfferDelete');

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnOfferDeleteDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnOfferDeleteInput,
  ): Promise<Result<Record<string, never>, OwnOfferDeleteFailure>> {
    const result = await this.#delete(context, input);
    this.#logger.log({
      msg: 'catalog.own-offer-delete',
      code: result.ok ? 'deleted' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #delete(
    context: CallContext,
    input: OwnOfferDeleteInput,
  ): Promise<Result<Record<string, never>, OwnOfferDeleteFailure>> {
    const { actor, market } = context;
    if (
      actor.kind !== 'authenticated' ||
      actor.population !== 'seller' ||
      actor.sellerId === null
    ) {
      return err({ code: 'access.denied' });
    }
    const sellerId = actor.sellerId;
    const offerId =
      typeof input === 'object' && input !== null && typeof input.offerId === 'string'
        ? parseId<'Offer'>(input.offerId)
        : null;
    if (offerId === null || !offerId.ok) {
      return err({ code: 'validation.failed', fields: [{ path: 'offerId', code: 'format' }] });
    }
    const { deps } = this;
    try {
      return await deps.unitOfWork.run<Record<string, never>, OwnOfferDeleteFailure>(
        market,
        async () => {
          const offer = await deps.offers.findById(market, offerId.value);
          if (
            offer === null ||
            offer.state.sellerId !== sellerId ||
            offer.state.status === 'deleted'
          ) {
            return err({ code: 'offer.not-found' } as const);
          }
          const product = await deps.products.findById(market, offer.state.productId);
          // Fail closed: a product that cannot be read cannot be shown to be a PLATFORM one.
          if (product === null || product.state.scope !== 'PLATFORM') {
            return err({ code: 'offer.delete-via-product' } as const);
          }
          const now = deps.clock.now();
          // Its open tags become `removed` (entry path `offer-delete`); delete asks nothing (ADR-0028 d5).
          const deleted = offer.delete({
            now,
            actor: { kind: 'seller', accountId: actor.accountId },
          });
          if (!deleted.ok) return err({ code: 'offer.not-found' } as const);
          await deps.offers.save(market, offer, { kind: 'seller', accountId: actor.accountId });
          await deps.outbox.append(context, offer.pendingEvents);
          return ok({});
        },
      );
    } catch (error) {
      if (error instanceof StaleAggregateError) return err({ code: 'conflict.stale' });
      throw error;
    }
  }
}
