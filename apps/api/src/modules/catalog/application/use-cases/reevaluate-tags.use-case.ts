import { Logger } from '@nestjs/common';
import { Temporal, err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { TagDecision } from '../../domain/offer-tag';
import type { ClaimEvaluator } from '../ports/claim-evaluator';
import type { OfferRepository } from '../ports/offer.repository';
import {
  TYPE_CAUSES,
  type CertificationCause,
  type PendingCertificationReevaluation,
  type PendingPublishReevaluation,
  type PendingReevaluation,
  type ReevaluationCounts,
  type TagReevaluationRequestRepository,
} from '../ports/tag-reevaluation-requests';
import type { TagSelection, TagSelectionReader } from '../ports/tag-selection.reader';
import type { OfferTagState } from '../../domain/offer-tag';
import { askClaimsMany } from '../tags/ask-claims';
import { addCounts, markRechecking, reaskOffers } from '../tags/reask-offers';
import type { ClaimQueryBuilder } from '../tags/claim-query-builder';
import {
  claimsFailClosed,
  factsInUnit,
  hashesOf,
  keptTagTypes,
  RETRY,
  type PreparedAsk,
} from '../tags/offer-claims';

/** Requests taken per run: ending certificates first, then the others, each oldest first. */
export const REEVALUATE_REQUESTS_PER_RUN = 10;
/** Offers per page of one request: one batched ask, then one unit per Offer. */
export const REEVALUATE_PAGE = 50;
/** Pages per request per run; the rest waits for the next run (the cursor resumes it). */
export const REEVALUATE_MAX_PAGES = 20;
/** Ending requests read per page by the pre-marking of a run (Hassan M-1). */
export const PREMARK_REQUEST_PAGE = 50;
/**
 * Pages of ending requests per run: 1,000 requests, far above what a Market writes between two
 * runs; the rest is pre-marked by the next run (and every one is listed first by `listPending`).
 */
export const PREMARK_MAX_REQUEST_PAGES = 20;

/**
 * A request still pending this long after its publish (about 20 runs of the 30 s job) is logged
 * as a warning on every run, so an operator can see Offers left `rechecking` (Hassan L-2).
 */
export const REEVALUATE_STUCK_AFTER = { minutes: 10 } as const;

export interface ReevaluateTagsOutput {
  /** Requests ended this run (settled or superseded). */
  readonly closed: number;
  /** Requests left pending (more pages, a lost race or an unanswered ask). */
  readonly open: number;
}

export type ReevaluateTagsFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' };

export interface ReevaluateTagsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly requests: TagReevaluationRequestRepository;
  readonly offers: OfferRepository;
  readonly claims: ClaimQueryBuilder;
  readonly evaluator: ClaimEvaluator;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  readonly tagSelection: TagSelectionReader;
}

/**
 * What a certification cause selects (design 5.5) and whether the selected `active` tags are
 * marked `rechecking` before the ask: an expired or revoked certificate makes the claim "no" from
 * its own instant, so no badge may stay while the answer is fetched (AC 12). A type cause (slice
 * 14) selects every tag of the type by its code, which the caller resolves from the subject (a
 * type id) first; without the code it throws (a programming error).
 */
export function selectionOf(
  cause: CertificationCause,
  subjectId: Id,
  typeCode: string | null = null,
): {
  readonly selection: TagSelection;
  readonly markFirst: boolean;
} {
  switch (cause) {
    case 'seller-certification-approved':
      return { selection: { by: 'seller', id: subjectId }, markFirst: false };
    case 'seller-certification-expired':
    case 'seller-certification-revoked':
    case 'product-certification-coverage-recheck':
      return { selection: { by: 'certificate', id: subjectId }, markFirst: true };
    case 'seller-certification-issuer-confirmed':
      return { selection: { by: 'certificate-version', id: subjectId }, markFirst: false };
    case 'claim-policy-changed':
    case 'product-certification-approved':
    case 'product-certification-coverage-changed':
      if (typeCode === null) throw new Error(`selectionOf: ${cause} needs the type code`);
      return { selection: { by: 'type', code: typeCode }, markFirst: false };
  }
}

/** True when the tag's own copy is what the selection names (the Offer's other tags are not). */
export function selectsTag(selection: TagSelection, tag: OfferTagState): boolean {
  switch (selection.by) {
    case 'certificate':
      return tag.copy?.certificateId === selection.id;
    case 'certificate-version':
      return tag.copy?.certificateVersionId === selection.id;
    case 'seller':
      return true;
    case 'type':
      return tag.typeCode === selection.code;
  }
}

type RequestOutcome = 'settled' | 'superseded' | 'pending';

/** One page of a request as read: superseded, or the Offers with what to ask for each. */
type PageRead =
  | 'superseded'
  | {
      readonly items: readonly {
        readonly offerId: Id<'Offer'>;
        readonly version: number;
        readonly prepared: PreparedAsk | null;
        /** Kept tags, but no query could be built (no handling): left `rechecking`, logged. */
        readonly skipped: boolean;
      }[];
      readonly full: boolean;
    };

const SYSTEM = { kind: 'system', accountId: null } as const;

/**
 * `catalog.reevaluate-tags` (catalog design 5.4 "Publish fan-out"; rule M1; slice 11): the job half
 * of a PLATFORM publish, and (slice 12, design 5.5) of a consumed certification event: a
 * `certification-event` request selects the Offers whose tags its cause names from catalog's own
 * rows (published copies only), a page at a time in Offer id order, and re-asks them through
 * {@link reaskOffers} (entry path `certification-event`, the event id on each history row); its
 * counts are the re-ask metric of 19.2 item 5. Rule `system`, per hosted Market, in the worker. For each pending
 * `revision-published` request, oldest first: if the product's published revision is no longer the
 * request's, the request is superseded (a newer publish wrote its own). Otherwise the product's
 * Offers are taken in id order after the request's cursor, a page at a time; the kept tags of the
 * page (`active`, `rechecking`, `suspended`) are asked against the published revision outside any
 * unit, at most 100 queries a call, and each Offer is settled in its own unit under its version,
 * with the product locked at the version asked about: allowed is `active` (badge back), refused is
 * `suspended` (off sale), entry path `revision-publish`, actor system.
 *
 * Idempotent and safe to overlap with a late run of itself: a settled request is never taken
 * again; a page settled twice changes nothing the second time; the cursor only moves forward.
 * Fail closed: an unanswered ask, a lost race or a stale answer stops the request for this run
 * and leaves its remaining tags `rechecking` (no badge) for the next run; nothing becomes `active`
 * without a fresh allowed decision.
 */
export class ReevaluateTags extends UseCase<
  Record<string, never>,
  ReevaluateTagsOutput,
  ReevaluateTagsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.reevaluate-tags',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('ReevaluateTags');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReevaluateTagsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<ReevaluateTagsOutput, ReevaluateTagsFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { market } = context;
    const { deps } = this;
    await this.#premarkEnding(context);
    const pending = await deps.unitOfWork.run(
      market,
      async () => ok(await deps.requests.listPending(market, REEVALUATE_REQUESTS_PER_RUN)),
      { readOnly: true },
    );
    if (!pending.ok) return err({ code: 'access.unavailable' });
    let closed = 0;
    let open = 0;
    const stuckBefore = deps.clock.now().subtract(REEVALUATE_STUCK_AFTER);
    for (const request of pending.value) {
      const outcome =
        request.kind === 'revision-published'
          ? await this.#settle(context, request)
          : await this.#settleCertification(context, request);
      if (outcome !== 'pending') {
        closed += 1;
        continue;
      }
      open += 1;
      if (Temporal.Instant.compare(request.createdAt, stuckBefore) < 0) {
        // Ids only (Hassan L-2): the request has been pending for many runs.
        this.#logger.warn({
          msg: 'catalog.reevaluate-tags.request-stuck',
          requestId: request.id,
          kind: request.kind,
          ...(request.kind === 'revision-published'
            ? { productId: request.productId, productRevisionId: request.productRevisionId }
            : { cause: request.cause }),
          marketId: market.marketId,
          correlationId: context.correlationId,
        });
      }
    }
    return ok({ closed, open });
  }

  /**
   * The pre-marking of every run (Hassan M-1, PR #398): before any ask, the selected `active` tags
   * of EVERY pending expired or revoked certificate request become `rechecking` (no badge), each
   * Offer in its own unit, however many requests wait and whatever the limit of
   * {@link REEVALUATE_REQUESTS_PER_RUN} settles. So a stored badge outlives the end of its
   * certificate by at most one run even while older requests keep failing. Only the Offers after
   * a request's cursor: those before it were settled on a fresh answer. Bounded: pages of
   * requests, and per request the pages of {@link REEVALUATE_MAX_PAGES}; what remains is marked
   * by the next run. Marking never activates anything, so it is safe to repeat.
   */
  async #premarkEnding(context: CallContext): Promise<void> {
    const { market } = context;
    const { deps } = this;
    let afterRequest: Id<'TagReevaluationRequest'> | null = null;
    let marked = 0;
    for (let page = 0; page < PREMARK_MAX_REQUEST_PAGES; page += 1) {
      const position: typeof afterRequest = afterRequest;
      const read: Result<readonly PendingCertificationReevaluation[], never> =
        await deps.unitOfWork.run(
          market,
          async (): Promise<Result<readonly PendingCertificationReevaluation[], never>> =>
            ok(
              await deps.requests.listPendingEnding(market, {
                afterId: position,
                limit: PREMARK_REQUEST_PAGE,
              }),
            ),
          { readOnly: true },
        );
      if (!read.ok || read.value.length === 0) break;
      for (const request of read.value) {
        marked += await this.#premarkRequest(context, request);
      }
      afterRequest = read.value[read.value.length - 1]!.id;
      if (read.value.length < PREMARK_REQUEST_PAGE) break;
    }
    if (marked > 0) {
      this.#logger.log({
        msg: 'catalog.reevaluate-tags.premarked',
        marked,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
    }
  }

  /** Marks the selected `active` tags of one ending request, page by page; the count marked. */
  async #premarkRequest(
    context: CallContext,
    request: PendingCertificationReevaluation,
  ): Promise<number> {
    const { market } = context;
    const { deps } = this;
    const { selection } = selectionOf(request.cause, request.subjectId);
    let cursor = request.cursorOfferId;
    let marked = 0;
    for (let page = 0; page < REEVALUATE_MAX_PAGES; page += 1) {
      const position = cursor;
      const read = await deps.unitOfWork.run(
        market,
        async () =>
          ok(
            await deps.tagSelection.selectedOffers(market, selection, {
              afterId: position,
              limit: REEVALUATE_PAGE,
              activeOnly: true,
            }),
          ),
        { readOnly: true },
      );
      if (!read.ok || read.value.length === 0) break;
      marked += await markRechecking(deps, context, read.value, {
        entryPath: 'certification-event',
        causeEventId: request.sourceEventId,
        selects: (tag) => selectsTag(selection, tag),
      });
      cursor = read.value[read.value.length - 1]!;
      if (read.value.length < REEVALUATE_PAGE) break;
    }
    return marked;
  }

  /**
   * Settles one `certification-event` request as far as this run goes (design 5.5): pages of at
   * most {@link REEVALUATE_PAGE} selected Offers after the cursor, each re-asked and settled. An
   * incomplete page (unanswered, `unavailable` or a lost race) keeps the cursor, so the next run
   * asks that page again; its tags stay `rechecking` meanwhile. A page that fails a second time
   * raises an alert (an error log) while its tags stay without badge.
   */
  async #settleCertification(
    context: CallContext,
    request: PendingCertificationReevaluation,
  ): Promise<RequestOutcome> {
    const { market } = context;
    const { deps } = this;
    // A type cause names a type id; the tags store its code (slice 14). Asked outside any unit.
    let typeCode: string | null = null;
    if ((TYPE_CAUSES as readonly string[]).includes(request.cause)) {
      const resolved = await deps.evaluator.typeCodeOf(context, request.subjectId);
      if (!resolved.ok) return 'pending';
      if (resolved.value === null) {
        // No such type in this Market: no tag can name it.
        return (await this.#close(context, request, 'settled', request.counts))
          ? 'settled'
          : 'pending';
      }
      typeCode = resolved.value;
    }
    const { selection, markFirst } = selectionOf(request.cause, request.subjectId, typeCode);
    let counts: ReevaluationCounts = request.counts;
    let cursor = request.cursorOfferId;
    for (let page = 0; page < REEVALUATE_MAX_PAGES; page += 1) {
      const read = await deps.unitOfWork.run(
        market,
        async () =>
          ok(
            await deps.tagSelection.selectedOffers(market, selection, {
              afterId: cursor,
              limit: REEVALUATE_PAGE,
            }),
          ),
        { readOnly: true },
      );
      if (!read.ok) return 'pending';
      const offerIds = read.value;
      const failedBefore = counts.unavailable > 0;
      const outcome = await reaskOffers(deps, context, offerIds, {
        entryPath: 'certification-event',
        causeEventId: request.sourceEventId,
        selects: (tag) => selectsTag(selection, tag),
        markFirst,
      });
      counts = addCounts(counts, outcome.counts);
      for (const offerId of outcome.skipped) {
        this.#skippedOffer(context, request, offerId, 'no-queries');
      }
      if (!outcome.complete) {
        if (failedBefore && outcome.counts.unavailable > 0) {
          // Alert (design 5.5): the same page failed again; its tags stay `rechecking`.
          this.#logger.error({
            msg: 'catalog.reevaluate-tags.batch-failed-twice',
            requestId: request.id,
            cause: request.cause,
            marketId: market.marketId,
            correlationId: context.correlationId,
          });
        }
        await this.#progress(context, request, cursor, counts);
        return 'pending';
      }
      const last = offerIds[offerIds.length - 1];
      if (last !== undefined) cursor = last;
      if (offerIds.length < REEVALUATE_PAGE) {
        return (await this.#close(context, request, 'settled', counts)) ? 'settled' : 'pending';
      }
      await this.#progress(context, request, cursor, counts);
    }
    return 'pending';
  }

  /** Settles one request as far as this run goes. */
  async #settle(
    context: CallContext,
    request: PendingPublishReevaluation,
  ): Promise<RequestOutcome> {
    const { market } = context;
    const { deps } = this;
    let counts: ReevaluationCounts = request.counts;
    let cursor = request.cursorOfferId;
    for (let page = 0; page < REEVALUATE_MAX_PAGES; page += 1) {
      const read = await deps.unitOfWork.run<PageRead, never>(
        market,
        async () => {
          const snapshot = await deps.claims.publishedSnapshot(market, request.productId);
          if (
            snapshot.facts === null ||
            snapshot.productVersion === null ||
            snapshot.facts.productRevisionId !== request.productRevisionId
          ) {
            return ok('superseded' as const);
          }
          const offers = await deps.offers.listOnProduct(market, request.productId, {
            afterId: cursor,
            limit: REEVALUATE_PAGE,
          });
          const items = offers.map((offer) => {
            const types = keptTagTypes(offer);
            const queries =
              types.length === 0 ? null : deps.claims.queries(offer.state, snapshot.facts!, types);
            const prepared: PreparedAsk | null =
              queries === null
                ? null
                : { facts: snapshot.facts, queries, productVersion: snapshot.productVersion };
            return {
              offerId: offer.state.id,
              version: offer.state.version,
              prepared,
              skipped: types.length > 0 && queries === null,
            };
          });
          return ok({ items, full: offers.length === REEVALUATE_PAGE });
        },
        { readOnly: true },
      );
      if (!read.ok) return 'pending';
      if (read.value === 'superseded') {
        return (await this.#close(context, request, 'superseded', counts))
          ? 'superseded'
          : 'pending';
      }
      const { items, full } = read.value;
      const asking = items.filter((item) => item.prepared !== null);
      const queryCount = asking.reduce(
        (sum, item) =>
          sum + [...item.prepared!.queries.values()].reduce((n, qs) => n + qs.length, 0),
        0,
      );
      const asked = await askClaimsMany(
        deps.evaluator,
        context,
        asking.map((item) => item.prepared!.queries),
      );
      if (!asked.ok) {
        // Fail closed: the tags stay `rechecking` (no badge); the next run asks again.
        counts = { ...counts, unavailable: counts.unavailable + queryCount };
        await this.#progress(context, request, cursor, counts);
        return 'pending';
      }
      counts = { ...counts, asked: counts.asked + queryCount };
      const decisionsOf = new Map(asking.map((item, i) => [item.offerId, asked.value[i]!]));
      for (const item of items) {
        if (item.skipped) this.#skipped(context, request, item.offerId, 'no-queries');
        if (item.prepared !== null) {
          const settled = await this.#settleOffer(
            context,
            item.offerId,
            item.version,
            item.prepared,
            decisionsOf.get(item.offerId)!,
          );
          if (settled === RETRY || settled === 'unavailable') {
            this.#skipped(
              context,
              request,
              item.offerId,
              settled === RETRY ? 'retry' : 'unavailable',
            );
            if (settled === 'unavailable') {
              counts = { ...counts, unavailable: counts.unavailable + 1 };
            }
            await this.#progress(context, request, cursor, counts);
            return 'pending';
          }
          counts = {
            ...counts,
            kept: counts.kept + settled.kept,
            switched: counts.switched + settled.switched,
            suspended: counts.suspended + settled.suspended,
            restored: counts.restored + settled.restored,
          };
        }
        cursor = item.offerId;
      }
      if (!full) {
        return (await this.#close(context, request, 'settled', counts)) ? 'settled' : 'pending';
      }
      await this.#progress(context, request, cursor, counts);
    }
    return 'pending';
  }

  /**
   * One Offer in its own unit: read again at the version the ask was built on, the product locked
   * at the version asked about, the kept tags settled on this request's decisions.
   */
  async #settleOffer(
    context: CallContext,
    offerId: Id<'Offer'>,
    version: number,
    prepared: PreparedAsk,
    decisions: ReadonlyMap<string, readonly TagDecision[]>,
  ): Promise<
    | { kept: number; switched: number; suspended: number; restored: number }
    | typeof RETRY
    | 'unavailable'
  > {
    const { market } = context;
    const { deps } = this;
    const hash = hashesOf(prepared);
    try {
      const outcome = await claimsFailClosed(() =>
        deps.unitOfWork.run<
          { kept: number; switched: number; suspended: number; restored: number } | typeof RETRY,
          { readonly code: 'claim.check-unavailable' }
        >(market, async () => {
          const offer = await deps.offers.findById(market, offerId);
          // Deleted since, or changed since: a delete asks nothing; a change re-asked already
          // or will be read again by the next run.
          if (offer === null || offer.state.status === 'deleted') {
            return ok({ kept: 0, switched: 0, suspended: 0, restored: 0 });
          }
          if (offer.state.version !== version) return ok(RETRY);
          const facts = await factsInUnit(deps.claims, market, offer.state.productId, prepared);
          if (facts === RETRY) return ok(RETRY);
          const settled = offer.settleTags({
            facts,
            decisions,
            entryPath: 'revision-publish',
            actor: SYSTEM,
            hash,
            now: deps.clock.now(),
          });
          if (!settled.ok) {
            return settled.error.code === 'claim.inputs-changed'
              ? ok(RETRY)
              : err({ code: 'claim.check-unavailable' } as const);
          }
          await deps.offers.save(market, offer, SYSTEM);
          await deps.outbox.append(context, offer.pendingEvents);
          return ok(settled.value);
        }),
      );
      if (!outcome.ok) return 'unavailable';
      return outcome.value;
    } catch (error) {
      if (error instanceof StaleAggregateError) return RETRY;
      throw error;
    }
  }

  async #progress(
    context: CallContext,
    request: PendingReevaluation,
    cursor: Id<'Offer'> | null,
    counts: ReevaluationCounts,
  ): Promise<void> {
    const { market } = context;
    // With no cursor yet, the counts alone (Mojtaba F4: an unanswered first page is recorded).
    await this.deps.unitOfWork.run(market, async () =>
      ok(await this.deps.requests.progress(market, request.id, { cursorOfferId: cursor, counts })),
    );
  }

  /** An Offer a certification request could not ask (no published revision or handling). */
  #skippedOffer(
    context: CallContext,
    request: PendingCertificationReevaluation,
    offerId: Id<'Offer'>,
    reason: 'no-queries',
  ): void {
    this.#logger.warn({
      msg: 'catalog.reevaluate-tags.offer-skipped',
      code: reason,
      requestId: request.id,
      cause: request.cause,
      offerId,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }

  /** An Offer this run left `rechecking`, by id and reason only (Hassan L-2). */
  #skipped(
    context: CallContext,
    request: PendingPublishReevaluation,
    offerId: Id<'Offer'>,
    reason: 'no-queries' | 'retry' | 'unavailable',
  ): void {
    this.#logger.warn({
      msg: 'catalog.reevaluate-tags.offer-skipped',
      code: reason,
      requestId: request.id,
      productId: request.productId,
      offerId,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }

  async #close(
    context: CallContext,
    request: PendingReevaluation,
    state: 'settled' | 'superseded',
    counts: ReevaluationCounts,
  ): Promise<boolean> {
    const { market } = context;
    const closed = await this.deps.unitOfWork.run(market, async () =>
      ok(
        await this.deps.requests.close(market, request.id, {
          state,
          counts,
          now: this.deps.clock.now(),
        }),
      ),
    );
    const done = closed.ok && closed.value;
    // The re-ask metric (19.2 item 5): how many tags each request asked and what changed.
    this.#logger.log({
      msg: 'catalog.reevaluate-tags.request',
      code: done ? state : 'not-pending',
      kind: request.kind,
      ...(request.kind === 'certification-event' ? { cause: request.cause } : {}),
      ...counts,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return done;
  }
}
