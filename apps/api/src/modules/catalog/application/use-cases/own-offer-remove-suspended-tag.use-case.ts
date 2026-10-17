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

export interface OwnOfferRemoveSuspendedTagInput {
  readonly offerId: string;
  readonly typeCode: string;
  /** The explicit "sell without this badge" confirmation; anything but `true` is refused. */
  readonly confirmSellWithoutBadge: unknown;
}

export type OwnOfferRemoveSuspendedTagFailure =
  | TagCommandFailure
  | { readonly code: 'access.denied' }
  | { readonly code: 'seller.not-eligible' }
  | { readonly code: 'conflict.stale' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface OwnOfferRemoveSuspendedTagDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly offers: OfferRepository;
  readonly eligibility: SellerEligibilityReader;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
}

/**
 * `own-offer.remove-suspended-tag` (catalog design 5.3 `suspended` → `removed`, 8.2; brief s7
 * "sell without this badge"; AC 19): a seller removes a `suspended` tag of their own Offer with an
 * explicit confirmation, so the Offer is listed again without the badge. Removing only restricts,
 * so nothing is asked. Rule: the key `catalog.own-product.edit`, the seller population, a seller
 * who may sell; refused in an acting-as session (8.2 "AA"; AC 19: an admin may not confirm it for
 * the seller). The confirmation must be the literal `true` (`validation.failed` otherwise). One
 * unit reads the Offer (another seller's, deleted or unknown: one `offer.not-found`), removes the
 * tag (`removed` by the seller, who and when recorded, entry path `seller-remove-suspended`, a
 * history row, the events) and stores it under the version it was read at. A tag that is not
 * `suspended` is `tag.not-suspended`.
 */
export class OwnOfferRemoveSuspendedTag extends UseCase<
  OwnOfferRemoveSuspendedTagInput,
  Record<string, never>,
  OwnOfferRemoveSuspendedTagFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-offer-remove-suspended-tag',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_EDIT.key] },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('OwnOfferRemoveSuspendedTag');

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnOfferRemoveSuspendedTagDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnOfferRemoveSuspendedTagInput,
  ): Promise<Result<Record<string, never>, OwnOfferRemoveSuspendedTagFailure>> {
    const result = await this.#remove(context, input);
    this.#logger.log({
      msg: 'catalog.own-offer-remove-suspended-tag',
      code: result.ok ? 'removed' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #remove(
    context: CallContext,
    input: OwnOfferRemoveSuspendedTagInput,
  ): Promise<Result<Record<string, never>, OwnOfferRemoveSuspendedTagFailure>> {
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
    if (input.confirmSellWithoutBadge !== true) {
      return err({
        code: 'validation.failed',
        fields: [{ path: 'confirmSellWithoutBadge', code: 'required' }],
      });
    }

    try {
      return await deps.unitOfWork.run<Record<string, never>, OwnOfferRemoveSuspendedTagFailure>(
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
          const removed = offer.removeSuspendedTag({
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
