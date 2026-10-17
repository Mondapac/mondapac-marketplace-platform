import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, IdGenerator, Result } from '@mondapac/shared-kernel';
import { isActingAsSession } from '../acting-as';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_EDIT } from '../../contracts/permissions';
import type { Offer } from '../../domain/offer';
import { isTagTypeCode, type TagBasis } from '../../domain/offer-tag';
import type { ClaimEvaluator } from '../ports/claim-evaluator';
import type { OfferRepository } from '../ports/offer.repository';
import type { SellerEligibilityReader } from '../ports/seller-eligibility.reader';
import type { ClaimQueryBuilder } from '../tags/claim-query-builder';
import {
  askPrepared,
  claimsFailClosed,
  factsInUnit,
  hashesOf,
  MAX_CLAIM_ATTEMPTS,
  RETRY,
  sellerTagActor,
  tagFailureOf,
  type PreparedAsk,
  type TagCommandFailure,
} from '../tags/offer-claims';
import type { SaveWorkingCopy } from '../working-copy/save-working-copy.service';

export interface OwnOfferAddTagInput {
  readonly offerId: string;
  readonly typeCode: unknown;
}

export interface OwnOfferAddTagOutput {
  readonly typeCode: string;
  readonly status: 'active';
  /** Every answer that shows a tag shows its basis (CERT-24, CERT-44; AC 14). */
  readonly basis: TagBasis;
}

export type OwnOfferAddTagFailure =
  | TagCommandFailure
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  | { readonly code: 'seller.not-eligible' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface OwnOfferAddTagDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly offers: OfferRepository;
  readonly eligibility: SellerEligibilityReader;
  readonly save: Pick<SaveWorkingCopy, 'reserveSaves'>;
  readonly claims: ClaimQueryBuilder;
  readonly evaluator: ClaimEvaluator;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

const INPUT_KEYS = ['offerId', 'typeCode'] as const;

/**
 * `own-offer.add-tag` (catalog design 5.2, 5.3, 8.2; CERT-21; AC 7 to 9, 15): a seller adds a
 * certification type to their own Offer. Rule: the key `catalog.own-product.edit`, the seller
 * population, a seller who may sell. The input is the Offer id and a type code only: no decision,
 * basis, certificate, issuer, status or badge (5.2 point 6). Refused in an acting-as session (8.2
 * "AA"); the actor carries no acting-as field until SEL-08, so the refusal arrives there.
 *
 * Order: seller actor; may-sell; closed input; the save budget; the type is an active type of the
 * Market (`tag.type-unknown`). Then, up to {@link MAX_CLAIM_ATTEMPTS} times: a read-only unit reads
 * the Offer (another seller's, deleted or unknown: one `offer.not-found`) and the claim facts of
 * the product's published revision (never published: `tag.product-not-published`, where the first
 * submit's `requestedTags` is the path, 5.1a point 6), and `ClaimQueryBuilder` builds one query per
 * variant; `evaluateClaims` is asked outside any unit; one unit reads the Offer again under its
 * version and the facts again, and the domain writes the tag `active` only when every variant is
 * allowed and every returned input equals the state being saved. A lost race asks again; after
 * the last attempt `conflict.retry`. A refusal names the type and the reason code;
 * `unavailable` refuses with `claim.check-unavailable` (fail closed).
 */
export class OwnOfferAddTag extends UseCase<
  OwnOfferAddTagInput,
  OwnOfferAddTagOutput,
  OwnOfferAddTagFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-offer-add-tag',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_EDIT.key] },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('OwnOfferAddTag');

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnOfferAddTagDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnOfferAddTagInput,
  ): Promise<Result<OwnOfferAddTagOutput, OwnOfferAddTagFailure>> {
    const result = await this.#add(context, input);
    this.#logger.log({
      msg: 'catalog.own-offer-add-tag',
      code: result.ok ? 'added' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #add(
    context: CallContext,
    input: OwnOfferAddTagInput,
  ): Promise<Result<OwnOfferAddTagOutput, OwnOfferAddTagFailure>> {
    const { actor } = context;
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
    if (!isTagTypeCode(input.typeCode)) return fail('typeCode', 'format');
    const typeCode = input.typeCode;

    const throttled = await deps.save.reserveSaves(context);
    if (throttled !== null) return err(throttled);

    const active = await deps.evaluator.activeTypeCodes(context);
    if (!active.ok) return err(active.error);
    if (!active.value.has(typeCode)) return err({ code: 'tag.type-unknown' });

    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
      const outcome = await claimsFailClosed(() =>
        this.#attempt(context, offerId.value, sellerId, typeCode),
      );
      if (outcome !== RETRY) return outcome;
    }
    return err({ code: 'conflict.retry' });
  }

  async #attempt(
    context: CallContext,
    offerId: Id<'Offer'>,
    sellerId: Id<'Seller'>,
    typeCode: string,
  ): Promise<Result<OwnOfferAddTagOutput, OwnOfferAddTagFailure> | typeof RETRY> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated') return err({ code: 'access.denied' });
    const { deps } = this;
    const ownOffer = async (): Promise<Offer | null> => {
      const offer = await deps.offers.findById(market, offerId);
      if (offer === null) return null;
      return offer.state.sellerId === sellerId && offer.state.status !== 'deleted' ? offer : null;
    };

    const guard = await deps.unitOfWork.run<
      { readonly version: number; readonly prepared: PreparedAsk | 'unavailable' },
      OwnOfferAddTagFailure
    >(
      market,
      async () => {
        const offer = await ownOffer();
        if (offer === null) return err({ code: 'offer.not-found' });
        if (offer.tags.some((tag) => tag.typeCode === typeCode)) return err({ code: 'tag.exists' });
        if (offer.state.handling === null) return err({ code: 'offer.handling-missing' });
        const { facts, productVersion } = await deps.claims.publishedSnapshot(
          market,
          offer.state.productId,
        );
        if (facts === null) return err({ code: 'tag.product-not-published' });
        const queries = deps.claims.queries(offer.state, facts, [typeCode]);
        if (queries === null) return err({ code: 'offer.handling-missing' });
        return ok({ version: offer.state.version, prepared: { facts, queries, productVersion } });
      },
      { readOnly: true },
    );
    if (!guard.ok) return guard;
    const prepared = guard.value.prepared;
    if (prepared === 'unavailable') return err({ code: 'claim.check-unavailable' });
    const hash = hashesOf(prepared);

    // Outside any unit (the facade opens its own); nothing of the answer is kept past this request.
    const asked = await askPrepared(deps.evaluator, context, prepared);
    if (!asked.ok) return err(asked.error);

    try {
      const written = await deps.unitOfWork.run<
        OwnOfferAddTagOutput | typeof RETRY,
        OwnOfferAddTagFailure
      >(market, async () => {
        const offer = await ownOffer();
        if (offer === null) return err({ code: 'offer.not-found' });
        if (offer.state.version !== guard.value.version) return ok(RETRY);
        // The facts again, in this unit: a revision published since the ask means asking again.
        const facts = await factsInUnit(deps.claims, market, offer.state.productId, prepared);
        if (facts === RETRY) return ok(RETRY);
        if (facts === null) return err({ code: 'tag.product-not-published' });
        const added = offer.addTags({
          tags: [{ tagId: deps.ids.next<'OfferTag'>(), typeCode }],
          facts,
          decisions: asked.value,
          entryPath: 'tag-add',
          actor: sellerTagActor(actor),
          hash,
          now: deps.clock.now(),
        });
        if (!added.ok) {
          return added.error.code === 'claim.inputs-changed'
            ? ok(RETRY)
            : err(tagFailureOf(added.error));
        }
        await deps.offers.save(market, offer, { kind: 'seller', accountId: actor.accountId });
        await deps.outbox.append(context, offer.pendingEvents);
        const tag = offer.tags.find((t) => t.typeCode === typeCode && t.status === 'active');
        if (tag?.copy == null) throw new Error('add-tag: the added tag has no copy');
        return ok({ typeCode, status: 'active', basis: tag.copy.basis });
      });
      if (written.ok && written.value === RETRY) return RETRY;
      return written as Result<OwnOfferAddTagOutput, OwnOfferAddTagFailure>;
    } catch (error) {
      if (error instanceof StaleAggregateError) return RETRY;
      throw error;
    }
  }
}
