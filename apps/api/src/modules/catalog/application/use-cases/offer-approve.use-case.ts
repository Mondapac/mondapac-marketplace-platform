import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_PRODUCT_APPROVE } from '../../contracts/permissions';
import type { CheckClaimText } from '../claim-text/check-claim-text.service';
import type { AllowedProductTypesReader } from '../ports/allowed-product-types.reader';
import type { OfferRepository } from '../ports/offer.repository';
import type { ProductRepository } from '../ports/product.repository';
import type { SellerEligibilityReader } from '../ports/seller-eligibility.reader';
import { refusalOf, type RefusedField } from '../working-copy/save-draft.service';
import { parseDecision, type ReviewValidationFailure } from '../offer-review-input';
import type { ClaimEvaluator } from '../ports/claim-evaluator';
import type { ClaimQueryBuilder } from '../tags/claim-query-builder';
import {
  askPrepared,
  claimsFailClosed,
  factsInUnit,
  hashesOf,
  keptTagTypes,
  MAX_CLAIM_ATTEMPTS,
  preparePublishedAsk,
  RETRY,
} from '../tags/offer-claims';

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
  | { readonly code: 'type.not-allowed' }
  | { readonly code: 'conflict.stale' }
  | { readonly code: 'claim-text.refused'; readonly fields: readonly RefusedField[] }
  | { readonly code: 'claim.check-unavailable' }
  | { readonly code: 'conflict.retry' }
  | ReviewValidationFailure;

export interface OfferApproveDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly offers: OfferRepository;
  readonly products: ProductRepository;
  readonly eligibility: SellerEligibilityReader;
  readonly allowedTypes: AllowedProductTypesReader;
  readonly check: CheckClaimText;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  /** The claim facts and queries (design 5.1). */
  readonly claims: ClaimQueryBuilder;
  readonly evaluator: ClaimEvaluator;
}

/**
 * `offer.approve` (catalog design 4.4, 8.2): a reviewer publishes an Offer that waits for its first
 * publication. Rule: the key `catalog.product.approve` and the admin population. The request names
 * the Offer and the version the reviewer saw. Guards, in order: the Offer exists in the Market
 * and waits for review (`offer.not-found`, `offer.not-pending-review`); its product is published
 * (`offer.product-not-published`); the owner may still sell (`seller.not-eligible`; `type.not-allowed` when SEL-12 no longer lists the product's type; a single
 * approval is refused, never skipped silently); the description passes the claim-text control again
 * (vocabulary may have grown since the submit). In one unit the Offer is read again and its version
 * must equal both the request's and the one that was checked, else `conflict.stale`. The history
 * row carries the admin as actor; `catalog.offer-published.v1` goes to the outbox.
 *
 * Tags (design 4.4, 5.1a point 3; slice 11, Hassan M1 condition of slice 8): every kept tag is
 * asked again against the product's published revision before the unit, and the unit settles
 * them on those decisions together with the publication: a refused tag is `suspended` and the
 * Offer is published off sale. The unit locks the product at the version asked about (a revision
 * published since means asking again). An unanswered ask refuses (`claim.check-unavailable`); a
 * lost race asks again, at most three times, then `conflict.retry`. Audit and mail join with the
 * notification module.
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
          productPublished: product?.state.status === 'published' && product.state.pausedAt === null,
          typeCode: product?.state.typeCode ?? null,
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

    // SEL-12 again: the seller's allowed types may have changed since the submit.
    const allowed = await deps.allowedTypes.allowedFor(context, seen.sellerId);
    if (allowed === null) return err({ code: 'access.unavailable' });
    if (allowed !== 'all' && (seen.typeCode === null || !allowed.has(seen.typeCode))) {
      return err({ code: 'type.not-allowed' });
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

    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
      const outcome = await claimsFailClosed(() => this.#publish(context, offerId, version));
      if (outcome !== RETRY) return outcome;
    }
    return err({ code: 'conflict.retry' });
  }

  /**
   * One attempt: every kept tag asked against the product's published revision outside any unit
   * (5.1a point 3), then one unit that settles them and publishes the Offer. {@link RETRY} when the
   * product moved since the ask (the lock of `factsInUnit`) or an answer is stale.
   */
  async #publish(
    context: CallContext,
    offerId: Id<'Offer'>,
    version: number,
  ): Promise<Result<Record<string, never>, OfferApproveFailure> | typeof RETRY> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated') return err({ code: 'access.denied' });
    const { deps } = this;

    const read = await deps.unitOfWork.run(
      market,
      async () => {
        const offer = await deps.offers.findById(market, offerId);
        if (offer === null) return ok(null);
        return ok(await preparePublishedAsk(deps.claims, market, offer.state, keptTagTypes(offer)));
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    if (read.value === null) return err({ code: 'offer.not-found' });
    const prepared = read.value;
    if (prepared === 'unavailable') return err({ code: 'claim.check-unavailable' });
    // Fail closed: an unanswered ask publishes nothing; the reviewer tries again.
    const asked = await askPrepared(deps.evaluator, context, prepared);
    if (!asked.ok) return err(asked.error);
    const hash = hashesOf(prepared);

    try {
      const written = await deps.unitOfWork.run<
        Record<string, never> | typeof RETRY,
        OfferApproveFailure
      >(market, async () => {
        const offer = await deps.offers.findById(market, offerId);
        if (offer === null) return err({ code: 'offer.not-found' } as const);
        if (offer.state.version !== version) return err({ code: 'conflict.stale' } as const);
        // Read again in the unit: the product may have left `published`, or been paused (an admin
        // pause, 4.1a), since the first read. Same rule as submit: a paused product is not on sale.
        const product = await deps.products.findById(market, offer.state.productId);
        if (product?.state.status !== 'published' || product.state.pausedAt !== null) {
          return err({ code: 'offer.product-not-published' } as const);
        }
        // The product locked at the version asked about, then its published facts again: a
        // revision published since the ask makes this attempt ask again (slice 11).
        const facts = await factsInUnit(deps.claims, market, offer.state.productId, prepared);
        if (facts === RETRY) return ok(RETRY);
        const now = deps.clock.now();
        const settled = offer.settleTags({
          facts,
          decisions: asked.value,
          entryPath: 'offer-approve',
          actor: { kind: 'admin', accountId: actor.accountId },
          hash,
          now,
        });
        if (!settled.ok) {
          return settled.error.code === 'claim.inputs-changed'
            ? ok(RETRY)
            : err({ code: 'claim.check-unavailable' } as const);
        }
        // A tag refused now is `suspended`: the Offer is published off sale (CERT-15).
        const approved = offer.approve({ now });
        if (!approved.ok) return err({ code: 'offer.not-pending-review' } as const);
        await deps.offers.save(market, offer, { kind: 'admin', accountId: actor.accountId });
        await deps.outbox.append(context, offer.pendingEvents);
        return ok({});
      });
      if (written.ok && written.value === RETRY) return RETRY;
      return written as Result<Record<string, never>, OfferApproveFailure>;
    } catch (error) {
      if (error instanceof StaleAggregateError) return err({ code: 'conflict.stale' });
      throw error;
    }
  }
}
