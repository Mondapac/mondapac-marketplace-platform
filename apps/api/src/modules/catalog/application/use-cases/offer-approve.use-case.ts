import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_PRODUCT_APPROVE } from '../../contracts/permissions';
import type { CheckClaimText } from '../claim-text/check-claim-text.service';
import type { OfferRepository } from '../ports/offer.repository';
import type { ProductRepository } from '../ports/product.repository';
import type { SellerEligibilityReader } from '../ports/seller-eligibility.reader';
import { refusalOf, type RefusedField } from '../working-copy/save-draft.service';
import { parseDecision, type ReviewValidationFailure } from '../offer-review-input';

export interface OfferApproveInput {
  readonly offerId: string;
  /** The Offer version the reviewer saw. */
  readonly version: number;
}

export type OfferApproveFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'offer.not-found' }
  | { readonly code: 'offer.not-pending-review' }
  | { readonly code: 'offer.product-not-published' }
  | { readonly code: 'seller.not-eligible' }
  | { readonly code: 'conflict.stale' }
  | { readonly code: 'claim-text.refused'; readonly fields: readonly RefusedField[] }
  | ReviewValidationFailure;

export interface OfferApproveDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly offers: OfferRepository;
  readonly products: ProductRepository;
  readonly eligibility: SellerEligibilityReader;
  readonly check: CheckClaimText;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
}

/**
 * `offer.approve` (catalog design 4.4, 8.2): a reviewer publishes an Offer that waits for its first
 * publication. Rule: the key `catalog.product.approve` and the admin population. The request names
 * the Offer and the version the reviewer saw. Guards, in order: the Offer exists in the Market
 * and waits for review (`offer.not-found`, `offer.not-pending-review`); its product is published
 * (`offer.product-not-published`); the owner may still sell (`seller.not-eligible`, a single
 * approval is refused, never skipped silently); the description passes the claim-text control again
 * (vocabulary may have grown since the submit). In one unit the Offer is read again and its version
 * must equal both the request's and the one that was checked, else `conflict.stale`. The history
 * row carries the admin as actor; `catalog.offer-published.v1` goes to the outbox. Tags and the
 * audit and mail effects join with slice 8 and the notification module.
 */
export class OfferApprove extends UseCase<
  OfferApproveInput,
  Record<string, never>,
  OfferApproveFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.offer-approve',
    rule: { kind: 'permissions', allOf: [CATALOG_PRODUCT_APPROVE.key] },
  };

  readonly #logger = new Logger('OfferApprove');

  constructor(
    gate: UseCaseGate,
    private readonly deps: OfferApproveDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OfferApproveInput,
  ): Promise<Result<Record<string, never>, OfferApproveFailure>> {
    const result = await this.#approve(context, input);
    this.#logger.log({
      msg: 'catalog.offer-approve',
      code: result.ok ? 'approved' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #approve(
    context: CallContext,
    input: OfferApproveInput,
  ): Promise<Result<Record<string, never>, OfferApproveFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const parsed = parseDecision(input, []);
    if (!parsed.ok) return parsed;
    const { offerId, version } = parsed.value;
    const { deps } = this;

    const guard = await deps.unitOfWork.run(
      market,
      async () => {
        const offer = await deps.offers.findById(market, offerId);
        if (offer === null) return ok(null);
        const product = await deps.products.findById(market, offer.state.productId);
        return ok({
          status: offer.state.status,
          version: offer.state.version,
          sellerId: offer.state.sellerId,
          description: offer.state.description,
          productPublished: product?.state.status === 'published',
        });
      },
      { readOnly: true },
    );
    if (!guard.ok) return err({ code: 'access.unavailable' });
    if (guard.value === null) return err({ code: 'offer.not-found' });
    const seen = guard.value;
    if (seen.status !== 'pending-first-publish') return err({ code: 'offer.not-pending-review' });
    if (seen.version !== version) return err({ code: 'conflict.stale' });
    if (!seen.productPublished) return err({ code: 'offer.product-not-published' });
    if (!(await deps.eligibility.isEligible(context, seen.sellerId))) {
      return err({ code: 'seller.not-eligible' });
    }

    const texts = Object.entries(seen.description).filter(([, text]) => text !== '');
    if (texts.length > 0) {
      const checked = await deps.check.execute(
        context,
        texts.map(([locale, text]) => ({ field: 'offer.description', ref: null, locale, text })),
      );
      if (!checked.ok) {
        return err(
          checked.error.code === 'validation.failed'
            ? { code: 'validation.failed', fields: [{ path: 'description', code: 'invalid' }] }
            : checked.error.code === 'access.denied'
              ? { code: 'access.denied' }
              : { code: 'access.unavailable' },
        );
      }
      const refused = checked.value.flatMap((verdict) =>
        verdict.code === 'clean' ? [] : (refusalOf(verdict) ?? []),
      );
      if (checked.value.some((verdict) => verdict.code !== 'clean') && refused.length === 0) {
        return err({ code: 'access.unavailable' });
      }
      if (refused.length > 0) return err({ code: 'claim-text.refused', fields: refused });
    }

    try {
      return await deps.unitOfWork.run<Record<string, never>, OfferApproveFailure>(
        market,
        async () => {
          const offer = await deps.offers.findById(market, offerId);
          if (offer === null) return err({ code: 'offer.not-found' } as const);
          if (offer.state.version !== version) return err({ code: 'conflict.stale' } as const);
          const approved = offer.approve({ now: deps.clock.now() });
          if (!approved.ok) return err({ code: 'offer.not-pending-review' } as const);
          await deps.offers.save(market, offer, { kind: 'admin', accountId: actor.accountId });
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
