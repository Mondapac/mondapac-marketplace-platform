import { Logger } from '@nestjs/common';
import { err, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_OWN_PRODUCT_EDIT } from '../../contracts/permissions';
import {
  decideHeldChange,
  type OfferChangeDecided,
  type OfferChangeDecisionDependencies,
  type OfferChangeDecisionFailure,
} from '../offer-change-decision';

export interface OwnOfferWithdrawChangeInput {
  readonly offerId: string;
}

export type OwnOfferWithdrawChangeFailure = OfferChangeDecisionFailure;

/**
 * `own-offer.withdraw-change` (risk-based Offer approval, slice 2c): a seller withdraws the held
 * change of their own live Offer. Rule: the key `catalog.own-product.edit` and the seller
 * population; the seller comes from the actor. The request names the Offer only. An Offer of
 * another seller, an unknown one and an Offer with no open change are one byte-identical
 * `offer-change.not-found`. The live Offer stays as it is; one unit, Offer row first, then the
 * change (`withdrawn`, the seller's account as the decider) and the audit row.
 */
export class OwnOfferWithdrawChange extends UseCase<
  OwnOfferWithdrawChangeInput,
  OfferChangeDecided,
  OwnOfferWithdrawChangeFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-offer-withdraw-change',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_EDIT.key] },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('OwnOfferWithdrawChange');

  constructor(
    gate: UseCaseGate,
    private readonly deps: OfferChangeDecisionDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnOfferWithdrawChangeInput,
  ): Promise<Result<OfferChangeDecided, OwnOfferWithdrawChangeFailure>> {
    const result = await this.#withdraw(context, input);
    this.#logger.log({
      msg: 'catalog.own-offer-withdraw-change',
      code: result.ok ? result.value.status : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #withdraw(
    context: CallContext,
    input: OwnOfferWithdrawChangeInput,
  ): Promise<Result<OfferChangeDecided, OwnOfferWithdrawChangeFailure>> {
    const { actor } = context;
    if (
      actor.kind !== 'authenticated' ||
      actor.population !== 'seller' ||
      actor.sellerId === null
    ) {
      return err({ code: 'access.denied' });
    }
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return err({ code: 'validation.failed', fields: [{ path: 'body', code: 'type' }] });
    }
    for (const key of Object.keys(input)) {
      if (key !== 'offerId') {
        return err({ code: 'validation.failed', fields: [{ path: key, code: 'unknown' }] });
      }
    }
    const offerId = typeof input.offerId === 'string' ? parseId<'Offer'>(input.offerId) : null;
    if (offerId === null || !offerId.ok) {
      return err({ code: 'validation.failed', fields: [{ path: 'offerId', code: 'format' }] });
    }
    return decideHeldChange(
      this.deps,
      context,
      { offerId: offerId.value },
      { kind: 'withdraw', sellerId: actor.sellerId },
    );
  }
}
