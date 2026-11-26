import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import { isActingAsSession } from '../acting-as';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_EDIT } from '../../contracts/permissions';
import { sellerReviewReasonsOf, type SellerReviewReason } from '../../domain/offer-review-policy';
import { PREVIEW_CONTACT_MARK, rateVerdict, SUBMIT_PREVIEW_LIMITS } from '../../domain/rate-limits';
import { judgeFirstPublication } from '../first-publication-review';
import type { AllowedProductTypesReader } from '../ports/allowed-product-types.reader';
import type { ClaimEvaluator } from '../ports/claim-evaluator';
import type { OfferReviewInputs } from '../ports/offer-review';
import type { OfferRepository } from '../ports/offer.repository';
import type { ProductRepository } from '../ports/product.repository';
import type { RateCounterKeys } from '../ports/rate-counter-keys';
import type { RateCounterRepository } from '../ports/rate-counter.repository';
import type { SellerEligibilityReader } from '../ports/seller-eligibility.reader';
import { keptTagTypes, parseRequestedTags } from '../tags/offer-claims';

export interface OwnOfferSubmitPreviewInput {
  readonly offerId: string;
  /** The same closed list the submit takes; absent is none. */
  readonly requestedTags?: unknown;
}

/**
 * What the seller is told before Submit. `publish`: as things stand the Offer goes live at the
 * submit. `review`: it waits for a check, with only the reasons a seller may act on by name (every
 * other reason is the one `held-for-review`). Not a promise: the submit decides again.
 */
export type OwnOfferSubmitPreviewOutput =
  | { readonly outcome: 'publish'; readonly reasons: readonly [] }
  | { readonly outcome: 'review'; readonly reasons: readonly SellerReviewReason[] };

export type OwnOfferSubmitPreviewFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'seller.not-eligible' }
  | { readonly code: 'offer.not-found' }
  | { readonly code: 'offer.not-submittable' }
  | { readonly code: 'offer.handling-missing' }
  | { readonly code: 'offer.product-not-published' }
  | { readonly code: 'type.not-allowed' }
  | { readonly code: 'tag.type-unknown' }
  | { readonly code: 'claim.check-unavailable' }
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

/**
 * Only reads, and the seller's preview counters (and the contact-text mark, {@link
 * PREVIEW_CONTACT_MARK}, on the same store). By construction there is no referral store,
 * audit, outbox, sampler, post-publication review, probation stamp or Offer save here: the preview
 * cannot write any of them (Hassan, handoff 7b point "writes nothing").
 */
export interface OwnOfferSubmitPreviewDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly offers: OfferRepository;
  readonly products: ProductRepository;
  readonly eligibility: SellerEligibilityReader;
  readonly allowedTypes: AllowedProductTypesReader;
  /** The Market's active certification types, for a closed `requestedTags` (a read). */
  readonly evaluator: Pick<ClaimEvaluator, 'activeTypeCodes'>;
  /** The Offer review policy's settings and facts: the same reader the submit uses. */
  readonly reviewInputs: OfferReviewInputs;
  readonly counters: RateCounterRepository;
  readonly counterKeys: RateCounterKeys;
  readonly clock: Clock;
}

/**
 * `own-offer.submit-preview` (risk-based Offer approval slice 7b; design 9.5 a): the submit's
 * review rules as a dry run, so a seller sees before Submit whether their draft goes live at once
 * or waits for a check. Rule: the key `catalog.own-product.edit`, the seller population and a
 * seller who may sell, as the submit. The guards are the submit's, in its order (the seller may
 * sell; the closed `requestedTags`; the Offer is theirs, else a byte-identical `offer.not-found`;
 * a draft; handling recorded; product on sale; a type the seller may sell), with the seller's
 * preview budget (10 a minute, 200 a day) taken right after the closed body, then {@link judgeFirstPublication}, the very function
 * the submit decides with.
 *
 * What it never says (handoff 7b "must never leak"):
 * - the sample: the sampler is not a dependency, so a sampled and an unsampled Offer answer the
 *   same, in the same time;
 * - R0, R1, R6, R7 and mode `all` by name: they are one `held-for-review` ({@link
 *   sellerReviewReasonsOf}); no count, no Trusted status, no category list;
 * - the matched contact text: `contact-text` names the rule only;
 * - R4 (price against the reference): that runs in pricing when the price is written, and the
 *   seller's held price is already on the Offer page. The preview never measures a price.
 *
 * Fail closed: a settings or fact read that failed answers `access.unavailable` (503, "we could not
 * check now"), never a guessed `publish`. The claim-text control and the badge checks are not
 * repeated here (the submit runs them; their own refusals have their own words), so the preview
 * spends no claim-text budget and asks certification nothing.
 */
export class OwnOfferSubmitPreview extends UseCase<
  OwnOfferSubmitPreviewInput,
  OwnOfferSubmitPreviewOutput,
  OwnOfferSubmitPreviewFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-offer-submit-preview',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_EDIT.key] },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('OwnOfferSubmitPreview');

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnOfferSubmitPreviewDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnOfferSubmitPreviewInput,
  ): Promise<Result<OwnOfferSubmitPreviewOutput, OwnOfferSubmitPreviewFailure>> {
    const result = await this.#preview(context, input);
    // The outcome only: never the reasons, so the log cannot be read back as the rules either.
    this.#logger.log({
      msg: 'catalog.own-offer-submit-preview',
      code: result.ok ? result.value.outcome : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #preview(
    context: CallContext,
    input: OwnOfferSubmitPreviewInput,
  ): Promise<Result<OwnOfferSubmitPreviewOutput, OwnOfferSubmitPreviewFailure>> {
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
    const offerId =
      typeof input === 'object' && input !== null && typeof input.offerId === 'string'
        ? parseId<'Offer'>(input.offerId)
        : null;
    if (offerId === null || !offerId.ok) {
      return err({ code: 'validation.failed', fields: [{ path: 'offerId', code: 'format' }] });
    }
    const requested = parseRequestedTags(input.requestedTags);
    if (!requested.ok) return err({ code: 'validation.failed', fields: [requested.error] });

    // The budget before any read past the seller's own eligibility, certification's active types
    // included (Hassan L1).
    const throttled = await this.#reserve(context, sellerId);
    if (throttled !== null) return err(throttled);

    if (requested.value.length > 0) {
      // As the submit: badge requests are not offered in an acting-as session (Hassan M1 of 5.1a).
      if (isActingAsSession(actor)) return err({ code: 'access.denied' });
      const active = await deps.evaluator.activeTypeCodes(context);
      if (!active.ok) return err({ code: 'claim.check-unavailable' });
      if (requested.value.some((code) => !active.value.has(code))) {
        return err({ code: 'tag.type-unknown' });
      }
    }

    const read = await deps.unitOfWork.run(
      market,
      async () => {
        const offer = await deps.offers.findById(market, offerId.value);
        if (
          offer === null ||
          offer.state.sellerId !== sellerId ||
          offer.state.status === 'deleted'
        ) {
          return ok(null);
        }
        const product = await deps.products.findById(market, offer.state.productId);
        const open = new Set(offer.tags.map((tag) => tag.typeCode));
        return ok({
          status: offer.state.status,
          handling: offer.state.handling,
          description: offer.state.description,
          productId: offer.state.productId,
          // A paused product stays `published`, but it is not on sale (catalog design 4.1a).
          productOnSale: product?.state.status === 'published' && product.state.pausedAt === null,
          typeCode: product?.state.typeCode ?? null,
          badgeTypes: [...keptTagTypes(offer), ...requested.value.filter((c) => !open.has(c))],
        });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    if (read.value === null) return err({ code: 'offer.not-found' });
    const offer = read.value;
    if (offer.status !== 'draft') return err({ code: 'offer.not-submittable' });
    if (!offer.productOnSale || offer.typeCode === null) {
      return err({ code: 'offer.product-not-published' });
    }
    if (offer.handling === null) return err({ code: 'offer.handling-missing' });
    const allowed = await deps.allowedTypes.allowedFor(context, sellerId);
    if (allowed === null) return err({ code: 'access.unavailable' });
    if (allowed !== 'all' && !allowed.has(offer.typeCode)) return err({ code: 'type.not-allowed' });

    const judged = await judgeFirstPublication(deps.reviewInputs, context, {
      sellerId,
      productId: offer.productId,
      offerId: offerId.value,
      handling: offer.handling,
      badgeTypes: offer.badgeTypes,
      description: offer.description,
    });
    // A read that failed is never a guess of either answer (handoff 7b point 7).
    if (judged.unreadable) return err({ code: 'access.unavailable' });
    if (judged.reasons.length === 0) return ok({ outcome: 'publish', reasons: [] });
    const reasons = sellerReviewReasonsOf(judged.reasons);
    // The seller is told `contact-text`, so they could edit the text until the preview stops
    // saying it. Mark it: an Offer they publish at once within 30 days goes on the
    // post-publication review list (security M1 of PR 1376). A mark that could not be written is
    // "we could not check", never an answer that leaves the probe unseen.
    if (reasons.includes('contact-text') && !(await this.#markContact(context, sellerId))) {
      return err({ code: 'access.unavailable' });
    }
    return ok({ outcome: 'review', reasons });
  }

  /** Counts {@link PREVIEW_CONTACT_MARK} on the seller; false when the store cannot answer. */
  async #markContact(context: CallContext, sellerId: Id<'Seller'>): Promise<boolean> {
    const { market } = context;
    try {
      const counter = {
        limit: PREVIEW_CONTACT_MARK,
        keyHash: this.deps.counterKeys.keyOf(market, PREVIEW_CONTACT_MARK.kind, sellerId),
      };
      const now = this.deps.clock.now();
      const marked = await this.deps.unitOfWork.run(market, async () =>
        ok(await this.deps.counters.reserve(market, [counter], now)),
      );
      if (marked.ok) return true;
    } catch {
      // A code only, below.
    }
    this.#logger.error({
      msg: 'catalog.own-offer-submit-preview.mark-failed',
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return false;
  }

  /** Counts the preview on the seller; a store that cannot answer refuses (fail closed). */
  async #reserve(
    context: CallContext,
    sellerId: Id<'Seller'>,
  ): Promise<
    | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
    | { readonly code: 'access.unavailable' }
    | null
  > {
    const { market } = context;
    try {
      const counters = SUBMIT_PREVIEW_LIMITS.map((limit) => ({
        limit,
        keyHash: this.deps.counterKeys.keyOf(market, limit.kind, sellerId),
      }));
      const now = this.deps.clock.now();
      const reserved = await this.deps.unitOfWork.run(market, async () =>
        ok(await this.deps.counters.reserve(market, counters, now)),
      );
      if (!reserved.ok) return { code: 'access.unavailable' };
      const verdict = rateVerdict(SUBMIT_PREVIEW_LIMITS, reserved.value, now);
      if (verdict.allowed) return null;
      // The seller id (an internal id, never a name) so a seller who keeps meeting the cap can be
      // found (Hassan L3; FE-20261126-offer-preview-r7-inference).
      this.#logger.warn({
        msg: 'catalog.request-throttled',
        kinds: SUBMIT_PREVIEW_LIMITS.map((limit) => limit.kind),
        sellerId,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return { code: 'request.throttled', retryAfterSeconds: verdict.retryAfterSeconds };
    } catch {
      this.#logger.error({
        msg: 'catalog.rate-counters-unavailable',
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return { code: 'access.unavailable' };
    }
  }
}
