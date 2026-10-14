import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_EDIT } from '../../contracts/permissions';
import { OFFER_HANDLINGS, type OfferHandling } from '../../domain/offer';
import type { OfferRepository } from '../ports/offer.repository';
import type { SellerEligibilityReader } from '../ports/seller-eligibility.reader';
import type { SaveWorkingCopy } from '../working-copy/save-working-copy.service';

/** The request as the route passes it: the Offer and the handling, a closed shape (B1, L8). */
export interface OwnOfferSetHandlingInput {
  readonly offerId: string;
  readonly handling: unknown;
}

export interface OwnOfferSetHandlingOutput {
  /** `['handling']` when the value changed; empty when the Offer already held it. */
  readonly changedFields: readonly string[];
}

export type OwnOfferSetHandlingFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  | { readonly code: 'seller.not-eligible' }
  | { readonly code: 'offer.not-found' }
  | { readonly code: 'offer.not-editable' }
  | { readonly code: 'conflict.stale' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface OwnOfferSetHandlingDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly offers: OfferRepository;
  readonly eligibility: SellerEligibilityReader;
  /** Spends the account's save budget (design 8.4: shared with draft saves and Offer edits). */
  readonly save: Pick<SaveWorkingCopy, 'reserveSaves'>;
  readonly clock: Clock;
}

const INPUT_KEYS = ['offerId', 'handling'] as const;

/**
 * `own-offer.set-handling` (catalog design 4.4, 8.2; Ali B1): a seller records how the goods of
 * their own Offer are handled. A command of its own, not part of `own-offer.edit`. Rule: the key
 * `catalog.own-product.edit` and the seller population; the gate refuses a seller who is not
 * approved. The seller comes from the actor. Guards, in order: seller actor, may-sell, closed
 * and well-formed input (handling is one of the four codes), the account's save budget, then one
 * unit that reads the Offer (another seller's, deleted and unknown Offers are one byte-identical
 * `offer.not-found`), sets the handling and stores it with an `edited` history row holding the
 * field id only. A waiting Offer returns to `draft`; a published Offer is `offer.not-editable`
 * until slice 8 re-asks every tag. Acting-as (Login as Seller) must refuse this command; the
 * actor has no acting-as field until SEL-08, so it is added there (open carry).
 */
export class OwnOfferSetHandling extends UseCase<
  OwnOfferSetHandlingInput,
  OwnOfferSetHandlingOutput,
  OwnOfferSetHandlingFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-offer-set-handling',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_EDIT.key] },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('OwnOfferSetHandling');

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnOfferSetHandlingDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnOfferSetHandlingInput,
  ): Promise<Result<OwnOfferSetHandlingOutput, OwnOfferSetHandlingFailure>> {
    const result = await this.#set(context, input);
    this.#logger.log({
      msg: 'catalog.own-offer-set-handling',
      code: result.ok ? 'set' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #set(
    context: CallContext,
    input: OwnOfferSetHandlingInput,
  ): Promise<Result<OwnOfferSetHandlingOutput, OwnOfferSetHandlingFailure>> {
    const { actor, market } = context;
    if (
      actor.kind !== 'authenticated' ||
      actor.population !== 'seller' ||
      actor.sellerId === null
    ) {
      return err({ code: 'access.denied' });
    }
    const sellerId = actor.sellerId;
    const { deps } = this;

    if (!(await deps.eligibility.isEligible(context, sellerId))) {
      return err({ code: 'seller.not-eligible' });
    }
    const fail = (path: string, code: string) =>
      err({ code: 'validation.failed', fields: [{ path, code }] } as const);
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return fail('body', 'type');
    }
    for (const key of Object.keys(input)) {
      if (!(INPUT_KEYS as readonly string[]).includes(key)) return fail(key, 'unknown');
    }
    const offerId = typeof input.offerId === 'string' ? parseId<'Offer'>(input.offerId) : null;
    if (offerId === null || !offerId.ok) return fail('offerId', 'format');
    if (
      typeof input.handling !== 'string' ||
      !(OFFER_HANDLINGS as readonly string[]).includes(input.handling)
    ) {
      return fail('handling', 'invalid');
    }
    const handling = input.handling as OfferHandling;

    const throttled = await deps.save.reserveSaves(context);
    if (throttled !== null) return err(throttled);

    try {
      return await deps.unitOfWork.run<OwnOfferSetHandlingOutput, OwnOfferSetHandlingFailure>(
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
          const set = offer.setHandling({ handling, now: deps.clock.now() });
          if (!set.ok) {
            return err(
              set.error.code === 'offer.not-editable'
                ? ({ code: 'offer.not-editable' } as const)
                : ({
                    code: 'validation.failed',
                    fields: [{ path: 'handling', code: 'invalid' }],
                  } as const),
            );
          }
          // A save with no pending change stores nothing.
          const refusal = await deps.offers.save(market, offer, {
            kind: 'seller',
            accountId: actor.accountId,
          });
          if (refusal !== null) return err({ code: 'conflict.stale' } as const);
          return ok({ changedFields: set.value });
        },
      );
    } catch (error) {
      if (error instanceof StaleAggregateError) return err({ code: 'conflict.stale' });
      throw error;
    }
  }
}
