import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type {
  CallContext,
  Clock,
  Id,
  IdGenerator,
  MarketContext,
  Result,
} from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_EDIT } from '../../contracts/permissions';
import { sameDescription, type Offer, type OfferRefusal } from '../../domain/offer';
import { sellerReviewReasonsOf, type SellerReviewReason } from '../../domain/offer-review-policy';
import { isWatched, type OfferEditReview, type WatchedChange } from '../offer-edit-review';
import { clearanceFromPolicy } from '../offer-review-clearance';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
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
  sellerTagActor,
} from '../tags/offer-claims';
import type { CheckClaimText } from '../claim-text/check-claim-text.service';
import { parseOfferContent } from '../offer-content';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { OfferRepository } from '../ports/offer.repository';
import type { SellerEligibilityReader } from '../ports/seller-eligibility.reader';
import { refusalOf, type RefusedField } from '../working-copy/save-draft.service';
import type { SaveWorkingCopy } from '../working-copy/save-working-copy.service';
import { previewedContact } from '../offer-post-review/preview-contact-mark';
import { receivePostReviewReason, sampleSourceRef } from '../offer-post-review/post-review-intake';
import type { OfferPostReviewRepository } from '../ports/offer-post-review';
import type { RateCounterKeys } from '../ports/rate-counter-keys';
import type { RateCounterWindows } from '../ports/rate-counter-windows';

/** The request as the route passes it: the whole content form, a closed shape (B1, L8). */
export interface OwnOfferEditInput {
  readonly offerId: string;
  readonly sellerSku: string;
  readonly conditionCode: string;
  /** Locale to text; empty is allowed. */
  readonly description: unknown;
  /** A held change of a live Offer is set aside and this edit is judged alone (slice 2c). */
  readonly replacePending?: unknown;
}

export interface OwnOfferEditOutput {
  /**
   * Field ids that changed on the Offer; empty when the form matched what was stored (nothing
   * was stored). A held description is not among them.
   */
  readonly changedFields: readonly string[];
  /** False when the review policy held the description of a live Offer (slice 2c). */
  readonly applied: boolean;
  /** The held change, when `applied` is false. */
  readonly pendingChangeId?: string;
  /** Why it is held, as a seller is told (`sellerReviewReasonsOf`), when `applied` is false. */
  readonly reasons?: readonly SellerReviewReason[];
}

export type OwnOfferEditFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  | { readonly code: 'seller.not-eligible' }
  | { readonly code: 'offer.not-found' }
  | { readonly code: 'offer.not-editable' }
  /** A watched edit of a live Offer with a held change open, without `replacePending`. */
  | { readonly code: 'offer.change-pending' }
  | { readonly code: 'offer.sku-taken' }
  | { readonly code: 'claim.check-unavailable' }
  | { readonly code: 'conflict.retry' }
  | { readonly code: 'claim-text.refused'; readonly fields: readonly RefusedField[] }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface OwnOfferEditDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly offers: OfferRepository;
  readonly eligibility: SellerEligibilityReader;
  readonly check: CheckClaimText;
  /** Spends the account's save budget (design 8.4: an Offer edit shares the draft-save limits). */
  readonly save: Pick<SaveWorkingCopy, 'reserveSaves'>;
  readonly policy: CatalogMarketPolicy;
  /** The claim facts and queries of the kept tags (design 5.1). */
  readonly claims: ClaimQueryBuilder;
  readonly evaluator: ClaimEvaluator;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  /** The edit rules of a live Offer (slice 2c). */
  readonly editReview: OfferEditReview;
  /**
   * A live description that goes live at once while the seller's submit-preview contact-text mark
   * is open goes on the post-publication review list (slice 7b; security N1 of PR 1376).
   */
  readonly counterWindows: RateCounterWindows;
  readonly counterKeys: RateCounterKeys;
  readonly postReviews: OfferPostReviewRepository;
  readonly ids: IdGenerator;
}

const INPUT_KEYS = [
  'offerId',
  'sellerSku',
  'conditionCode',
  'description',
  'replacePending',
] as const;

/**
 * `own-offer.edit` (catalog design 4.4, 8.2; OFR-01; AC 11, 33): a seller edits the content of
 * their own Offer, published or not. Rule: the key `catalog.own-product.edit` and the seller
 * population. The seller comes from the actor, never from the request; the input is the whole
 * content form and is closed, with no handling, attestation or tag field (B1).
 *
 * Guards, in order: the seller may sell; the input is well formed (closed shape, the condition is
 * one of the Market's, the description fits the Market's locales and size bounds); the account's
 * save budget is spent (`request.throttled`; shared with draft saves, so a loop of edits is
 * bounded before any read or matcher call); the Offer exists, is the actor's and is not deleted,
 * else a byte-identical `offer.not-found` (another seller's Offer reveals nothing); the locales
 * whose text changed pass the claim-text control (a hit refuses the whole edit, nothing is
 * stored; an unchanged text is not re-checked); every kept tag of the Offer is asked again
 * (`evaluateClaims` through `ClaimQueryBuilder`, outside any unit; "ask on every write", AC 11). In
 * one unit the Offer is read again under the version that was checked and asked, edited, its
 * kept tags settled (a tag no longer allowed is `suspended` and the Offer goes off sale; one
 * `unavailable` answer refuses the edit with `claim.check-unavailable`, fail closed) and stored
 * with its history row and events. A lost race starts again from the read, at most
 * {@link MAX_CLAIM_ATTEMPTS} times, then `conflict.retry`. A `pending-first-publish` or
 * `changes-needed` Offer returns to `draft`; a published Offer stays published.
 *
 * Edit rules of a live Offer (risk-based Offer approval, slice 2c; ADR-0051): on a `published`
 * Offer a changed description is a watched change. With a held change open it is refused
 * (`offer.change-pending`) unless `replacePending: true`, which sets the open change aside
 * (`resubmitted`) and judges this edit alone; SKU and condition edits always apply. The Market's
 * review settings are read outside any unit (fail closed: any failure holds). No reason: the edit
 * applies at once and an `edit` referral with no reason is stored. A reason (R5 contact text, or
 * mode `all`): in one unit the SKU and condition apply at once, the description is held as a
 * pending change, the Offer's version rises once, and the referral and audit rows name it; the
 * answer is `applied: false` with the change id and reasons.
 */
export class OwnOfferEdit extends UseCase<
  OwnOfferEditInput,
  OwnOfferEditOutput,
  OwnOfferEditFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-offer-edit',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_EDIT.key] },
    // A seller who is not approved cannot edit Offers.
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('OwnOfferEdit');

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnOfferEditDependencies,
    /** The entry path kept tags are settled under; `import-row` for the seller import's rows. */
    private readonly entryPath: 'offer-edit' | 'import-row' = 'offer-edit',
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnOfferEditInput,
  ): Promise<Result<OwnOfferEditOutput, OwnOfferEditFailure>> {
    const result = await this.#edit(context, input);
    this.#logger.log({
      msg: 'catalog.own-offer-edit',
      code: result.ok ? (result.value.applied ? 'edited' : 'held') : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #edit(
    context: CallContext,
    input: OwnOfferEditInput,
  ): Promise<Result<OwnOfferEditOutput, OwnOfferEditFailure>> {
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
    const parsed = this.#parse(market, input);
    if (!parsed.ok) return parsed;

    // Spent before any read or the claim matcher, so a loop of edits is bounded.
    const throttled = await deps.save.reserveSaves(context);
    if (throttled !== null) return err(throttled);

    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
      const outcome = await claimsFailClosed(() => this.#attempt(context, parsed.value, sellerId));
      if (outcome !== RETRY) return outcome;
    }
    return err({ code: 'conflict.retry' });
  }

  async #attempt(
    context: CallContext,
    form: {
      readonly offerId: Id<'Offer'>;
      readonly sellerSku: string;
      readonly conditionCode: string;
      readonly description: Record<string, string>;
      readonly replacePending: boolean;
    },
    sellerId: Id<'Seller'>,
  ): Promise<Result<OwnOfferEditOutput, OwnOfferEditFailure> | typeof RETRY> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated') return err({ code: 'access.denied' });
    const { deps } = this;
    const { offerId, sellerSku, conditionCode, description } = form;

    // Read-only first: the ownership answer, the texts that changed since the last save and the
    // queries of the kept tags (an edit changes no claim input, so they are of the stored state).
    const guard = await deps.unitOfWork.run(
      market,
      async () => {
        const offer = await this.#ownOffer(market, offerId, sellerId);
        if (offer === null) return ok(null);
        const prepared = await preparePublishedAsk(
          deps.claims,
          market,
          offer.state,
          keptTagTypes(offer),
        );
        const open =
          offer.state.status === 'published'
            ? await deps.editReview.openChange(market, offer.state.id)
            : null;
        return ok({ offer, prepared, hasOpenChange: open !== null });
      },
      { readOnly: true },
    );
    if (!guard.ok) return err({ code: 'access.unavailable' });
    if (guard.value === null) return err({ code: 'offer.not-found' });
    const { offer: seen, prepared } = guard.value;
    if (prepared === 'unavailable') return err({ code: 'claim.check-unavailable' });
    const stored = seen.state.description;
    const guardVersion = seen.state.version;
    // The watched part of this edit (slice 2c): a changed description of a live Offer.
    const live = seen.state.status === 'published';
    const watched: WatchedChange = {
      addedBadgeTypes: [],
      ...(live && !sameDescription(description, stored) ? { newDescription: description } : {}),
    };
    const watchedEdit = live && isWatched(watched);
    if (watchedEdit && guard.value.hasOpenChange && !form.replacePending) {
      return err({ code: 'offer.change-pending' });
    }

    // The claim-text control runs outside any unit (it opens its own); a hit refuses the edit.
    const texts = Object.entries(description).filter(
      ([locale, text]) => text !== '' && stored[locale] !== text,
    );
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
      const refused = checked.value.flatMap((verdict) => refusalOf(verdict) ?? []);
      if (refused.length > 0) return err({ code: 'claim-text.refused', fields: refused });
    }

    // Every kept tag, outside any unit (the facade opens its own).
    const asked = await askPrepared(deps.evaluator, context, prepared);
    if (!asked.ok) return err(asked.error);
    const hash = hashesOf(prepared);

    // The review policy, outside any unit; any failure holds the change (fail closed).
    const subject = { offerId, sellerId: seen.state.sellerId, productId: seen.state.productId };
    const verdict = watchedEdit ? await deps.editReview.verdict(context, subject, watched) : null;
    const reasons = verdict?.reasons ?? [];
    const held = reasons.length > 0;
    // A new live description applied at once: read the seller's preview mark before the unit.
    const contactMarked =
      watched.newDescription !== undefined && !held
        ? await previewedContact(deps, context, sellerId, this.#logger)
        : false;

    try {
      const written = await deps.unitOfWork.run<
        OwnOfferEditOutput | typeof RETRY,
        OwnOfferEditFailure
      >(market, async () => {
        const offer = await this.#ownOffer(market, offerId, sellerId);
        if (offer === null) return err({ code: 'offer.not-found' } as const);
        // The changed texts were checked and the tags asked against the first read: another
        // change in between means the baseline is stale, so this attempt writes nothing and
        // starts again (Hassan 7b-1 L-1; design 5.2 point 3).
        if (offer.state.version !== guardVersion) return ok(RETRY);
        // Every change of a held change raised the version, so this read matches the guard's.
        const replaced = watchedEdit ? await deps.editReview.openChange(market, offerId) : null;
        if (replaced !== null && !form.replacePending) {
          return err({ code: 'offer.change-pending' } as const);
        }
        const now = deps.clock.now();
        // A held description stays as it is live; SKU and condition apply at once.
        const edited = offer.edit({
          sellerSku,
          conditionCode,
          description: held ? offer.state.description : description,
          now,
          review: clearanceFromPolicy(verdict),
        });
        if (!edited.ok) return err(failureOf(edited.error));
        // The facts again, in this unit: a revision published since the ask means asking again.
        const facts = await factsInUnit(deps.claims, market, offer.state.productId, prepared);
        if (facts === RETRY) return ok(RETRY);
        const settled = offer.settleTags({
          facts,
          decisions: asked.value,
          entryPath: this.entryPath,
          actor: sellerTagActor(actor),
          hash,
          now,
        });
        if (!settled.ok) {
          return settled.error.code === 'claim.inputs-changed'
            ? ok(RETRY)
            : err({ code: 'claim.check-unavailable' } as const);
        }
        if (held || replaced !== null) offer.markReviewChange();
        const refusal = await deps.offers.save(market, offer, {
          kind: 'seller',
          accountId: actor.accountId,
        });
        if (refusal !== null) return err({ code: refusal } as const);
        // The answer is the same either way, so the seller is not told.
        if (contactMarked) {
          await receivePostReviewReason(deps, market, {
            offerId,
            sellerId,
            productId: offer.state.productId,
            reason: 'preview-contact-text',
            sourceRef: sampleSourceRef(offer.state.version),
            now,
          });
        }
        const pendingChangeId = watchedEdit
          ? await deps.editReview.settle(context, {
              offer,
              baseVersion: guardVersion,
              reasons,
              change: watched,
              replaced,
              now,
            })
          : null;
        await deps.outbox.append(context, offer.pendingEvents);
        return ok(
          pendingChangeId === null
            ? { changedFields: edited.value, applied: true }
            : {
                changedFields: edited.value,
                applied: false,
                pendingChangeId,
                reasons: sellerReviewReasonsOf(reasons),
              },
        );
      });
      if (written.ok && written.value === RETRY) return RETRY;
      return written as Result<OwnOfferEditOutput, OwnOfferEditFailure>;
    } catch (error) {
      if (error instanceof StaleAggregateError) return RETRY;
      throw error;
    }
  }

  /** The Offer when it exists in the Market, is this seller's and is not deleted, else null. */
  async #ownOffer(
    market: MarketContext,
    offerId: Id<'Offer'>,
    sellerId: Id<'Seller'>,
  ): Promise<Offer | null> {
    const offer = await this.deps.offers.findById(market, offerId);
    if (offer === null) return null;
    const { sellerId: owner, status } = offer.state;
    return owner === sellerId && status !== 'deleted' ? offer : null;
  }

  #parse(
    market: MarketContext,
    input: OwnOfferEditInput,
  ): Result<
    {
      offerId: Id<'Offer'>;
      sellerSku: string;
      conditionCode: string;
      description: Record<string, string>;
      replacePending: boolean;
    },
    OwnOfferEditFailure
  > {
    const fail = (path: string, code: string) =>
      err({ code: 'validation.failed', fields: [{ path, code }] } as const);
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return fail('body', 'type');
    }
    for (const key of Object.keys(input)) {
      if (!(INPUT_KEYS as readonly string[]).includes(key)) return fail(key, 'unknown');
    }
    const offer = typeof input.offerId === 'string' ? parseId<'Offer'>(input.offerId) : null;
    if (offer === null || !offer.ok) return fail('offerId', 'format');
    if (input.replacePending !== undefined && typeof input.replacePending !== 'boolean') {
      return fail('replacePending', 'type');
    }
    const content = parseOfferContent(this.deps.policy, market, input);
    if (!content.ok) return content;
    return ok({
      offerId: offer.value,
      ...content.value,
      replacePending: input.replacePending === true,
    });
  }
}

function failureOf(refusal: OfferRefusal): OwnOfferEditFailure {
  switch (refusal.code) {
    case 'offer.not-editable':
      return { code: 'offer.not-editable' };
    case 'offer.sku-invalid':
      return { code: 'validation.failed', fields: [{ path: 'sellerSku', code: 'format' }] };
    case 'offer.condition-invalid':
      return { code: 'validation.failed', fields: [{ path: 'conditionCode', code: 'format' }] };
    case 'offer.description-invalid':
      return { code: 'validation.failed', fields: [{ path: 'description', code: 'format' }] };
  }
}
