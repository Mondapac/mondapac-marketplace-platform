import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { isActingAsSession } from '../acting-as';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_EDIT } from '../../contracts/permissions';
import { isTagTypeCode } from '../../domain/offer-tag';
import type { OfferRepository } from '../ports/offer.repository';
import type { SellerEligibilityReader } from '../ports/seller-eligibility.reader';
import { sellerTagActor, tagFailureOf, type TagCommandFailure } from '../tags/offer-claims';

export interface OwnOfferRemoveTagInput {
  readonly offerId: string;
  readonly typeCode: string;
}

export type OwnOfferRemoveTagFailure =
  | TagCommandFailure
  | { readonly code: 'access.denied' }
  | { readonly code: 'seller.not-eligible' }
  | { readonly code: 'conflict.stale' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface OwnOfferRemoveTagDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly offers: OfferRepository;
  readonly eligibility: SellerEligibilityReader;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
}

/**
 * `own-offer.remove-tag` (catalog design 5.3, 8.2): a seller removes an `active` tag of their own
 * Offer. Removing only restricts, so nothing is asked. Rule: the key `catalog.own-product.edit`,
 * the seller population, a seller who may sell; refused in an acting-as session (8.2 "AA", arrives
 * with SEL-08's actor field). One unit reads the Offer (another seller's, deleted or unknown: one
 * `offer.not-found`), removes the tag (`removed`, who and when recorded, a history row, the event)
 * and stores it under the version it was read at. A suspended tag is `tag.suspended`: it is
 * removed only with the "sell without this badge" confirmation (slice 12).
 */
export class OwnOfferRemoveTag extends UseCase<
  OwnOfferRemoveTagInput,
  Record<string, never>,
  OwnOfferRemoveTagFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-offer-remove-tag',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_EDIT.key] },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('OwnOfferRemoveTag');

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnOfferRemoveTagDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnOfferRemoveTagInput,
  ): Promise<Result<Record<string, never>, OwnOfferRemoveTagFailure>> {
    const result = await this.#remove(context, input);
    this.#logger.log({
      msg: 'catalog.own-offer-remove-tag',
      code: result.ok ? 'removed' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #remove(
    context: CallContext,
    input: OwnOfferRemoveTagInput,
  ): Promise<Result<Record<string, never>, OwnOfferRemoveTagFailure>> {
    const { actor, market } = context;
    if (
      actor.kind !== 'authenticated' ||
      actor.population !== 'seller' ||
      actor.sellerId === null ||
      // Not offered in an acting-as session (design 8.2 "AA"; Hassan L1).
      isActingAsSession(actor)
    ) {
      return err({ code: 'access.denied' });
    }
    const sellerId = actor.sellerId;
    const { deps } = this;
    if (!(await deps.eligibility.isEligible(context, sellerId))) {
      return err({ code: 'seller.not-eligible' });
    }
    const offerId =
      typeof input === 'object' && input !== null && typeof input.offerId === 'string'
        ? parseId<'Offer'>(input.offerId)
        : null;
    if (offerId === null || !offerId.ok) {
      return err({ code: 'validation.failed', fields: [{ path: 'offerId', code: 'format' }] });
    }
    if (!isTagTypeCode(input.typeCode)) {
      return err({ code: 'validation.failed', fields: [{ path: 'typeCode', code: 'format' }] });
    }
    const typeCode = input.typeCode;

    try {
      return await deps.unitOfWork.run<Record<string, never>, OwnOfferRemoveTagFailure>(
        market,
        async () => {
          const offer = await deps.offers.findById(market, offerId.value);
          if (
            offer === null ||
            offer.state.sellerId !== sellerId ||
            offer.state.status === 'deleted'
          ) {
            return err({ code: 'offer.not-found' });
          }
          const removed = offer.removeTag({
            typeCode,
            actor: sellerTagActor(actor),
            now: deps.clock.now(),
          });
          if (!removed.ok) {
            if (removed.error.code === 'claim.inputs-changed')
              return err({ code: 'conflict.stale' });
            return err(tagFailureOf(removed.error));
          }
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
