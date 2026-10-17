import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import { isActingAsSession } from '../acting-as';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_EDIT } from '../../contracts/permissions';
import { Offer } from '../../domain/offer';
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
  type PreparedAsk,
  RETRY,
  sellerTagActor,
} from '../tags/offer-claims';
import type { OfferRepository } from '../ports/offer.repository';
import type { SellerEligibilityReader } from '../ports/seller-eligibility.reader';
import type { SaveWorkingCopy } from '../working-copy/save-working-copy.service';

/** The request as the route passes it: the Offer and the seller's choice, a closed shape (B1, L8). */
export interface OwnOfferRecordAttestationInput {
  readonly offerId: string;
  /** `true` records the attestation, `false` withdraws it. */
  readonly attested: unknown;
}

export interface OwnOfferRecordAttestationOutput {
  /** `['attestation']` when the record changed; empty when the Offer already held the choice. */
  readonly changedFields: readonly string[];
  /** When the recorded attestation was made (the first record is kept); null when none. */
  readonly attestationRecordedAt: string | null;
}

export type OwnOfferRecordAttestationFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  | { readonly code: 'seller.not-eligible' }
  | { readonly code: 'offer.not-found' }
  | { readonly code: 'offer.not-editable' }
  | { readonly code: 'offer.attestation-needs-sealed-original' }
  | { readonly code: 'conflict.stale' }
  | { readonly code: 'claim.check-unavailable' }
  | { readonly code: 'conflict.retry' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface OwnOfferRecordAttestationDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly offers: OfferRepository;
  readonly eligibility: SellerEligibilityReader;
  /** Spends the account's save budget (design 8.4: shared with draft saves and Offer edits). */
  readonly save: Pick<SaveWorkingCopy, 'reserveSaves'>;
  /** The claim facts and queries of the kept tags (design 5.1). */
  readonly claims: ClaimQueryBuilder;
  readonly evaluator: ClaimEvaluator;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
}

const INPUT_KEYS = ['offerId', 'attested'] as const;

/**
 * `own-offer.record-attestation` (ADR-0012 decision 4; catalog design 4.4, 5.4, 8.2; Ali B1): a
 * seller records, or withdraws, the per-Offer attestation that the stock is genuine, sealed and
 * unaltered, which a manufacturer-basis tag needs together with `SEALED_ORIGINAL`. A seller
 * commitment: only the seller's own request sets it (never AI, Import or a bulk action; R13,
 * R14), and it is refused in an acting-as session. Rule: the key `catalog.own-product.edit` and
 * the seller population; the gate refuses a seller who is not approved. The seller comes from
 * the actor, the author of the record from the session's account. Guards, in order: seller
 * actor, may-sell, closed and well-formed input (`attested` is a boolean), the account's save
 * budget, then a read-only unit that reads the Offer (another seller's, deleted and unknown
 * Offers are one byte-identical `offer.not-found`) and builds the queries of every kept tag
 * against the state after the change. The attestation is a claim input (design 5.1), so every
 * kept tag is asked again outside any unit and settled in the unit that stores the change, after
 * the product lock (`factsInUnit`): a withdrawal can suspend a manufacturer-basis tag (the Offer
 * goes off sale) or switch its basis, a recording can restore one; one `unavailable` answer
 * refuses the change (`claim.check-unavailable`, fail closed). Recording needs the handling
 * `SEALED_ORIGINAL` (`offer.attestation-needs-sealed-original`). The history row is
 * `attestation-recorded` or `attestation-withdrawn` with the actor's account; the Offer keeps
 * the instant and the account of the record. A lost race asks again, at most
 * {@link MAX_CLAIM_ATTEMPTS} times, then `conflict.retry`.
 */
export class OwnOfferRecordAttestation extends UseCase<
  OwnOfferRecordAttestationInput,
  OwnOfferRecordAttestationOutput,
  OwnOfferRecordAttestationFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-offer-record-attestation',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_EDIT.key] },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('OwnOfferRecordAttestation');

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnOfferRecordAttestationDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnOfferRecordAttestationInput,
  ): Promise<Result<OwnOfferRecordAttestationOutput, OwnOfferRecordAttestationFailure>> {
    const result = await this.#record(context, input);
    this.#logger.log({
      msg: 'catalog.own-offer-record-attestation',
      code: result.ok ? 'recorded' : result.error.code,
      changed: result.ok ? result.value.changedFields.length > 0 : false,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #record(
    context: CallContext,
    input: OwnOfferRecordAttestationInput,
  ): Promise<Result<OwnOfferRecordAttestationOutput, OwnOfferRecordAttestationFailure>> {
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
    if (typeof input.attested !== 'boolean') return fail('attested', 'type');
    const attested = input.attested;

    const throttled = await deps.save.reserveSaves(context);
    if (throttled !== null) return err(throttled);

    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
      const outcome = await claimsFailClosed(() =>
        this.#attempt(context, offerId.value, sellerId, attested),
      );
      if (outcome !== RETRY) return outcome;
    }
    return err({ code: 'conflict.retry' });
  }

  async #attempt(
    context: CallContext,
    offerId: Id<'Offer'>,
    sellerId: Id<'Seller'>,
    attested: boolean,
  ): Promise<
    Result<OwnOfferRecordAttestationOutput, OwnOfferRecordAttestationFailure> | typeof RETRY
  > {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated') return err({ code: 'access.denied' });
    const { deps } = this;
    const ownOffer = async (): Promise<Offer | null> => {
      const offer = await deps.offers.findById(market, offerId);
      if (offer === null) return null;
      return offer.state.sellerId === sellerId && offer.state.status !== 'deleted' ? offer : null;
    };
    const refusalOf = (code: 'offer.not-editable' | 'offer.attestation-needs-sealed-original') =>
      err({ code } as const);

    // Read-only first: the Offer and the queries of its kept tags against the new attestation.
    const guard = await deps.unitOfWork.run<
      | { readonly version: number; readonly prepared: PreparedAsk | 'unavailable' }
      | null
      | OwnOfferRecordAttestationFailure,
      never
    >(
      market,
      async () => {
        const offer = await ownOffer();
        if (offer === null) return ok(null);
        const types = keptTagTypes(offer);
        // The state after the change, built on a copy that is never stored.
        const after = Offer.restore(offer.state, offer.tags);
        const changed = after.recordAttestation({
          attested,
          accountId: actor.accountId,
          now: deps.clock.now(),
        });
        if (!changed.ok) return ok({ code: changed.error.code });
        const prepared = await preparePublishedAsk(deps.claims, market, after.state, types);
        return ok({ version: offer.state.version, prepared });
      },
      { readOnly: true },
    );
    if (!guard.ok) return err({ code: 'access.unavailable' });
    if (guard.value === null) return err({ code: 'offer.not-found' });
    if ('code' in guard.value) return err(guard.value);
    const { version, prepared } = guard.value;
    if (prepared === 'unavailable') return err({ code: 'claim.check-unavailable' });

    const asked = await askPrepared(deps.evaluator, context, prepared);
    if (!asked.ok) return err(asked.error);
    const hash = hashesOf(prepared);

    try {
      const written = await deps.unitOfWork.run<
        OwnOfferRecordAttestationOutput | typeof RETRY,
        OwnOfferRecordAttestationFailure
      >(market, async () => {
        const offer = await ownOffer();
        if (offer === null) return err({ code: 'offer.not-found' } as const);
        if (offer.state.version !== version) return ok(RETRY);
        const now = deps.clock.now();
        const recorded = offer.recordAttestation({ attested, accountId: actor.accountId, now });
        if (!recorded.ok) return refusalOf(recorded.error.code);
        // The product locked, then the facts again: a revision published since the ask means
        // asking again (slice 11).
        const facts = await factsInUnit(deps.claims, market, offer.state.productId, prepared);
        if (facts === RETRY) return ok(RETRY);
        const settled = offer.settleTags({
          facts,
          decisions: asked.value,
          entryPath: 'attestation-change',
          actor: sellerTagActor(actor),
          hash,
          now,
        });
        if (!settled.ok) {
          return settled.error.code === 'claim.inputs-changed'
            ? ok(RETRY)
            : err({ code: 'claim.check-unavailable' } as const);
        }
        // A save with no pending change stores nothing.
        const refusal = await deps.offers.save(market, offer, {
          kind: 'seller',
          accountId: actor.accountId,
        });
        if (refusal !== null) return err({ code: 'conflict.stale' } as const);
        await deps.outbox.append(context, offer.pendingEvents);
        const at = offer.state.attestationRecordedAt;
        return ok({
          changedFields: recorded.value,
          attestationRecordedAt: at === null ? null : at.toString(),
        });
      });
      if (written.ok && written.value === RETRY) return RETRY;
      return written as Result<OwnOfferRecordAttestationOutput, OwnOfferRecordAttestationFailure>;
    } catch (error) {
      if (error instanceof StaleAggregateError) return RETRY;
      throw error;
    }
  }
}
