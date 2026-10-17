import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type {
  CallContext,
  Clock,
  Id,
  IdGenerator,
  Result,
  Temporal,
} from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_EDIT } from '../../contracts/permissions';
import type { CheckClaimText } from '../claim-text/check-claim-text.service';
import type { AllowedProductTypesReader } from '../ports/allowed-product-types.reader';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { OfferRepository } from '../ports/offer.repository';
import type { ProductRepository } from '../ports/product.repository';
import type { SellerEligibilityReader } from '../ports/seller-eligibility.reader';
import type { ClaimEvaluator } from '../ports/claim-evaluator';
import type { Offer } from '../../domain/offer';
import type { ClaimFacts, TagActor, TagDecision } from '../../domain/offer-tag';
import type { ClaimQueryBuilder } from '../tags/claim-query-builder';
import {
  askPrepared,
  hashesOf,
  keptTagTypes,
  MAX_CLAIM_ATTEMPTS,
  parseRequestedTags,
  preparePublishedAsk,
  RETRY,
  sellerTagActor,
} from '../tags/offer-claims';
import { refusalOf, type RefusedField } from '../working-copy/save-draft.service';

export interface OwnOfferSubmitInput {
  readonly offerId: string;
  /** Type codes to tag at the submit (design 5.1a point 6); absent is none. Closed schema. */
  readonly requestedTags?: unknown;
}

export interface OwnOfferSubmitOutput {
  /** True when the Offer is published at once; false when it waits for review. */
  readonly published: boolean;
}

export type OwnOfferSubmitFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'seller.not-eligible' }
  | { readonly code: 'offer.not-found' }
  | { readonly code: 'offer.not-submittable' }
  | { readonly code: 'offer.handling-missing' }
  | { readonly code: 'offer.product-not-published' }
  | { readonly code: 'type.not-allowed' }
  | { readonly code: 'tag.type-unknown' }
  | {
      readonly code: 'claim.requested-tag-not-allowed';
      readonly tags: readonly { readonly typeCode: string; readonly reason: string }[];
    }
  | { readonly code: 'claim.check-unavailable' }
  | { readonly code: 'conflict.stale' }
  | { readonly code: 'conflict.retry' }
  | { readonly code: 'claim-text.refused'; readonly fields: readonly RefusedField[] }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface OwnOfferSubmitDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly offers: OfferRepository;
  readonly products: ProductRepository;
  readonly eligibility: SellerEligibilityReader;
  readonly allowedTypes: AllowedProductTypesReader;
  readonly check: CheckClaimText;
  readonly policy: CatalogMarketPolicy;
  readonly outbox: OutboxWriter;
  /** The claim facts and queries (design 5.1). */
  readonly claims: ClaimQueryBuilder;
  readonly evaluator: ClaimEvaluator;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * `own-offer.submit` (catalog design 4.4; OFR-01): a seller submits a `draft` Offer of their own.
 * Rule: the key `catalog.own-product.edit`, the seller population and a seller who may sell. The
 * request names the Offer only; the seller comes from the actor. Guards, in order: the seller may
 * sell; the Offer exists and is theirs (else a byte-identical `offer.not-found`); the product is
 * published (`offer.product-not-published`) and of a type the seller may sell (SEL-12; an error
 * from the reader is `access.unavailable`, ADR-0031); every description text passes the
 * claim-text control again, since the vocabulary can have grown since the last save. In one unit
 * the Offer is read again, its version must equal the one that was checked (else
 * `conflict.stale`), the Market's `catalog.approval-required` is read, and the Offer waits for
 * review or is published at once. Handling must already be recorded (`offer.handling-missing`).
 *
 * Tags (design 5.1a point 6, 5.2, 5.4): every kept tag is asked again against the product's
 * published revision, and `requestedTags` (closed: at most 20 distinct active type codes of the
 * Market, else `validation.failed` or `tag.type-unknown`) asks for each new type; both outside
 * any unit, after the claim-text control. If any requested type is not allowed the whole submit is
 * refused (`claim.requested-tag-not-allowed`, per type the reason code); an `unavailable` answer
 * refuses it (`claim.check-unavailable`). In the unit a kept tag no longer allowed is `suspended`
 * and a requested one is written `active` (the product is published, so this is the add of 5.3).
 * A lost race asks again, at most three times, then `conflict.retry`. A non-empty `requestedTags`
 * must be refused in an acting-as session (Hassan M1); the actor has no acting-as field until
 * SEL-08 (open carry).
 */
export class OwnOfferSubmit extends UseCase<
  OwnOfferSubmitInput,
  OwnOfferSubmitOutput,
  OwnOfferSubmitFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-offer-submit',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_EDIT.key] },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('OwnOfferSubmit');

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnOfferSubmitDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnOfferSubmitInput,
  ): Promise<Result<OwnOfferSubmitOutput, OwnOfferSubmitFailure>> {
    const result = await this.#submit(context, input);
    this.#logger.log({
      msg: 'catalog.own-offer-submit',
      code: result.ok ? (result.value.published ? 'published' : 'pending') : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #submit(
    context: CallContext,
    input: OwnOfferSubmitInput,
  ): Promise<Result<OwnOfferSubmitOutput, OwnOfferSubmitFailure>> {
    const { actor } = context;
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
    if (requested.value.length > 0) {
      const active = await deps.evaluator.activeTypeCodes(context);
      if (!active.ok) return err(active.error);
      if (requested.value.some((code) => !active.value.has(code))) {
        return err({ code: 'tag.type-unknown' });
      }
    }

    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
      const outcome = await this.#attempt(context, offerId.value, sellerId, requested.value);
      if (outcome !== RETRY) return outcome;
    }
    return err({ code: 'conflict.retry' });
  }

  async #attempt(
    context: CallContext,
    offerId: Id<'Offer'>,
    sellerId: Id<'Seller'>,
    requested: readonly string[],
  ): Promise<Result<OwnOfferSubmitOutput, OwnOfferSubmitFailure> | typeof RETRY> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated') return err({ code: 'access.denied' });
    const { deps } = this;

    // Read-only first: ownership, the product's state and the texts to check.
    const guard = await deps.unitOfWork.run(
      market,
      async () => {
        const offer = await deps.offers.findById(market, offerId);
        if (
          offer === null ||
          offer.state.sellerId !== sellerId ||
          offer.state.status === 'deleted'
        ) {
          return ok(null);
        }
        const product = await deps.products.findById(market, offer.state.productId);
        // The kept tags and the requested types that have no open tag yet (an open one is kept).
        const open = new Set(offer.tags.map((tag) => tag.typeCode));
        const kept = keptTagTypes(offer);
        const added = requested.filter((code) => !open.has(code));
        const types = [...kept, ...added];
        const prepared =
          types.length === 0 ||
          offer.state.handling === null ||
          product?.state.status !== 'published'
            ? null
            : await preparePublishedAsk(deps.claims, market, offer.state, types);
        return ok({
          description: offer.state.description,
          status: offer.state.status,
          version: offer.state.version,
          handling: offer.state.handling,
          productStatus: product?.state.status ?? null,
          typeCode: product?.state.typeCode ?? null,
          added,
          prepared,
        });
      },
      { readOnly: true },
    );
    if (!guard.ok) return err({ code: 'access.unavailable' });
    if (guard.value === null) return err({ code: 'offer.not-found' });
    const { description, status, version, productStatus, typeCode, added } = guard.value;
    if (status !== 'draft') return err({ code: 'offer.not-submittable' });
    if (productStatus !== 'published' || typeCode === null) {
      return err({ code: 'offer.product-not-published' });
    }
    if (guard.value.handling === null) return err({ code: 'offer.handling-missing' });
    const prepared = guard.value.prepared ?? { facts: null, queries: new Map() };
    if (prepared === 'unavailable') return err({ code: 'claim.check-unavailable' });
    const allowed = await deps.allowedTypes.allowedFor(context, sellerId);
    if (allowed === null) return err({ code: 'access.unavailable' });
    if (allowed !== 'all' && !allowed.has(typeCode)) return err({ code: 'type.not-allowed' });

    // Every non-empty text, outside any unit (the control opens its own).
    const texts = Object.entries(description).filter(([, text]) => text !== '');
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
      // Anything that is not plainly clean refuses, so an unknown verdict can never pass.
      const refused = checked.value.flatMap((verdict) =>
        verdict.code === 'clean' ? [] : (refusalOf(verdict) ?? []),
      );
      if (checked.value.some((verdict) => verdict.code !== 'clean') && refused.length === 0) {
        return err({ code: 'access.unavailable' });
      }
      if (refused.length > 0) return err({ code: 'claim-text.refused', fields: refused });
    }

    // Every kept and requested tag, outside any unit (the facade opens its own).
    const asked = await askPrepared(deps.evaluator, context, prepared);
    if (!asked.ok) return err(asked.error);
    const hash = hashesOf(prepared);

    try {
      const written = await deps.unitOfWork.run<
        OwnOfferSubmitOutput | typeof RETRY,
        OwnOfferSubmitFailure
      >(market, async () => {
        const offer = await deps.offers.findById(market, offerId);
        if (
          offer === null ||
          offer.state.sellerId !== sellerId ||
          offer.state.status === 'deleted'
        ) {
          return err({ code: 'offer.not-found' } as const);
        }
        if (offer.state.version !== version) return ok(RETRY);
        const product = await deps.products.findById(market, offer.state.productId);
        if (product?.state.status !== 'published') {
          return err({ code: 'offer.product-not-published' } as const);
        }
        let approvalRequired: boolean;
        try {
          approvalRequired = await deps.policy.approvalRequired(market);
        } catch {
          return err({ code: 'access.unavailable' } as const);
        }
        const now = deps.clock.now();
        const submitted = offer.submit({ approvalRequired, now });
        if (!submitted.ok) {
          return err(
            submitted.error.code === 'offer.handling-missing'
              ? ({ code: 'offer.handling-missing' } as const)
              : ({ code: 'offer.not-submittable' } as const),
          );
        }
        const tagged = this.#settleTags(
          offer,
          prepared.facts,
          asked.value,
          added,
          hash,
          sellerTagActor(actor),
          now,
        );
        if (tagged !== null) return tagged;
        await deps.offers.save(market, offer, { kind: 'seller', accountId: actor.accountId });
        await deps.outbox.append(context, offer.pendingEvents);
        return ok({ published: submitted.value.published });
      });
      if (written.ok && written.value === RETRY) return RETRY;
      return written as Result<OwnOfferSubmitOutput, OwnOfferSubmitFailure>;
    } catch (error) {
      if (error instanceof StaleAggregateError) return RETRY;
      throw error;
    }
  }

  /**
   * In the submit unit: the kept tags settled and the requested ones added, both on the decisions
   * of this request whose inputs equal the state being saved. Null when done; else the answer.
   */
  #settleTags(
    offer: Offer,
    facts: ClaimFacts | null,
    decisions: ReadonlyMap<string, readonly TagDecision[]>,
    added: readonly string[],
    hash: (canonical: string) => string,
    actor: TagActor,
    now: Temporal.Instant,
  ): Result<typeof RETRY, OwnOfferSubmitFailure> | null {
    const settled = offer.settleTags({
      facts,
      decisions,
      entryPath: 'offer-edit',
      actor,
      hash,
      now,
    });
    if (!settled.ok) {
      return settled.error.code === 'claim.inputs-changed'
        ? ok(RETRY)
        : err({ code: 'claim.check-unavailable' });
    }
    if (added.length === 0) return null;
    if (facts === null) return err({ code: 'claim.check-unavailable' });
    const result = offer.addTags({
      tags: added.map((typeCode) => ({ tagId: this.deps.ids.next<'OfferTag'>(), typeCode })),
      facts,
      decisions,
      entryPath: 'tag-add',
      actor,
      hash,
      now,
    });
    if (result.ok) return null;
    switch (result.error.code) {
      case 'claim.inputs-changed':
        return ok(RETRY);
      case 'claim.tag-not-allowed':
        return err({ code: 'claim.requested-tag-not-allowed', tags: result.error.tags });
      case 'offer.handling-missing':
        return err({ code: 'offer.handling-missing' });
      default:
        return err({ code: 'claim.check-unavailable' });
    }
  }
}
