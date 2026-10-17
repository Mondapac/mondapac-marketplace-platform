import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { TagDecision } from '../../domain/offer-tag';
import type { ClaimEvaluator } from '../ports/claim-evaluator';
import type { OfferRepository } from '../ports/offer.repository';
import type {
  PendingReevaluation,
  ReevaluationCounts,
  TagReevaluationRequestRepository,
} from '../ports/tag-reevaluation-requests';
import { askClaimsMany } from '../tags/ask-claims';
import type { ClaimQueryBuilder } from '../tags/claim-query-builder';
import {
  claimsFailClosed,
  factsInUnit,
  hashesOf,
  keptTagTypes,
  RETRY,
  type PreparedAsk,
} from '../tags/offer-claims';

/** Requests taken per run, oldest first. */
export const REEVALUATE_REQUESTS_PER_RUN = 10;
/** Offers per page of one request: one batched ask, then one unit per Offer. */
export const REEVALUATE_PAGE = 50;
/** Pages per request per run; the rest waits for the next run (the cursor resumes it). */
export const REEVALUATE_MAX_PAGES = 20;

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
      }[];
      readonly full: boolean;
    };

const SYSTEM = { kind: 'system', accountId: null } as const;

/**
 * `catalog.reevaluate-tags` (catalog design 5.4 "Publish fan-out"; rule M1; slice 11): the job half
 * of a PLATFORM publish. Rule `system`, per hosted Market, in the worker. For each pending
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
    const pending = await deps.unitOfWork.run(
      market,
      async () => ok(await deps.requests.listPending(market, REEVALUATE_REQUESTS_PER_RUN)),
      { readOnly: true },
    );
    if (!pending.ok) return err({ code: 'access.unavailable' });
    let closed = 0;
    let open = 0;
    for (const request of pending.value) {
      const outcome = await this.#settle(context, request);
      if (outcome === 'pending') open += 1;
      else closed += 1;
    }
    return ok({ closed, open });
  }

  /** Settles one request as far as this run goes. */
  async #settle(context: CallContext, request: PendingReevaluation): Promise<RequestOutcome> {
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
            return { offerId: offer.state.id, version: offer.state.version, prepared };
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
        if (item.prepared !== null) {
          const settled = await this.#settleOffer(
            context,
            item.offerId,
            item.version,
            item.prepared,
            decisionsOf.get(item.offerId)!,
          );
          if (settled === RETRY || settled === 'unavailable') {
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
    if (cursor === null) return;
    await this.deps.unitOfWork.run(market, async () =>
      ok(await this.deps.requests.progress(market, request.id, { cursorOfferId: cursor, counts })),
    );
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
    this.#logger.log({
      msg: 'catalog.reevaluate-tags.request',
      code: done ? state : 'not-pending',
      ...counts,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return done;
  }
}
