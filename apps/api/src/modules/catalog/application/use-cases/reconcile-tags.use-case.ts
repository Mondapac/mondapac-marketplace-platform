import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result, Temporal } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { ClaimEvaluator } from '../ports/claim-evaluator';
import type { OfferRepository } from '../ports/offer.repository';
import { NO_COUNTS, type ReevaluationCounts } from '../ports/tag-reevaluation-requests';
import type { StaleTag, TagSelectionReader } from '../ports/tag-selection.reader';
import type { ClaimQueryBuilder } from '../tags/claim-query-builder';
import { addCounts, reaskOffers } from '../tags/reask-offers';

/** A tag is due for its reconciliation re-ask when its last ask is at least this old (design 5.6). */
export const RECONCILE_AFTER = { hours: 24 } as const;
/** Tags read per page (oldest ask first); their Offers are asked together. */
export const RECONCILE_PAGE = 100;
/** Pages per run; the rest waits for the next run (every tag is still due then). */
export const RECONCILE_MAX_PAGES = 10;
/** Consecutive failed runs of a Market that raise the alert (design 5.6: two). */
export const RECONCILE_ALERT_AFTER = 2;

export type ReconcileTagsOutput = ReevaluationCounts & {
  /** Offers that could not be asked (no published revision or no handling), logged by id. */
  readonly skipped: number;
};

export type ReconcileTagsFailure = { readonly code: 'access.denied' };

export interface ReconcileTagsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly offers: OfferRepository;
  readonly claims: ClaimQueryBuilder;
  readonly evaluator: ClaimEvaluator;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  readonly tagSelection: TagSelectionReader;
}

/**
 * `catalog.reconcile-tags` (catalog design 5.6; ADR-0028 d10; slice 12): the backstop that repairs
 * a lost certification event in both directions (AC 12, AC 13). Rule `system`, per hosted Market,
 * in the worker. Every `active`, `rechecking` and `suspended` tag of both bases whose copy names a
 * revision with a `published` decision (5.1a point 5; joined, not the flag) is re-asked once its
 * last ask is {@link RECONCILE_AFTER} old, oldest first, a page of tags at a time; their Offers are
 * re-asked and settled each in its own unit through {@link reaskOffers} (entry path
 * `reconciliation`, system actor). So every live tag is asked at least daily, spread over the day
 * instead of at one wall-clock hour (the scheduler runs jobs at an interval; deviation recorded in
 * the data design's as-built note of migration 10).
 *
 * Fail closed (5.2 point 4): an unanswered page (the batched call failed) marks its `active` tags
 * `rechecking` (no badge) and ends the run; they are still due, so the next run asks them first.
 * An Offer answered `unavailable` alone has its tags marked `rechecking` and logged by id, and the
 * run goes on (Hassan L-2). A `suspended` tag is made
 * `active` only by a fresh allowed answer. The run's counts (asked, kept, switched, suspended,
 * restored, unavailable) are a metric in the log line, not an audit row; each tag change has its
 * history row. Two consecutive failed runs of a Market log the alert; the count is kept per
 * process (a restart or a second worker starts it again), recorded in the as-built note.
 */
export class ReconcileTags extends UseCase<
  Record<string, never>,
  ReconcileTagsOutput,
  ReconcileTagsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.reconcile-tags',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('ReconcileTags');
  /** Consecutive failed runs per Market, in this process (the alert of design 5.6). */
  readonly #failedRuns = new Map<string, number>();

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReconcileTagsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<ReconcileTagsOutput, ReconcileTagsFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { market } = context;
    const { deps } = this;
    const before = deps.clock.now().subtract(RECONCILE_AFTER);
    let counts: ReevaluationCounts = NO_COUNTS;
    let skipped = 0;
    let failed = false;
    let after: { readonly evaluatedAt: Temporal.Instant; readonly tagId: Id } | null = null;
    for (let page = 0; page < RECONCILE_MAX_PAGES; page += 1) {
      const position: typeof after = after;
      const read: Result<readonly StaleTag[], never> = await deps.unitOfWork.run(
        market,
        async (): Promise<Result<readonly StaleTag[], never>> =>
          ok(
            await deps.tagSelection.staleTags(market, {
              before,
              after: position,
              limit: RECONCILE_PAGE,
            }),
          ),
        { readOnly: true },
      );
      if (!read.ok || read.value.length === 0) {
        failed = !read.ok;
        break;
      }
      const tags: readonly StaleTag[] = read.value;
      const offerIds = [...new Set(tags.map((tag) => tag.offerId as string))] as Id<'Offer'>[];
      const outcome = await reaskOffers(deps, context, offerIds, {
        entryPath: 'reconciliation',
        causeEventId: null,
        selects: () => true,
        markFirst: false,
      });
      counts = addCounts(counts, outcome.counts);
      skipped += outcome.skipped.length;
      for (const offerId of outcome.skipped) {
        this.#logger.warn({
          msg: 'catalog.reconcile-tags.offer-skipped',
          code: 'no-queries',
          offerId,
          marketId: market.marketId,
          correlationId: context.correlationId,
        });
      }
      for (const offerId of outcome.unavailableOffers) {
        // One Offer unanswered (Hassan L-2): its tags are `rechecking` and still due; the run
        // goes on with the next Offers.
        this.#logger.warn({
          msg: 'catalog.reconcile-tags.offer-unavailable',
          offerId,
          marketId: market.marketId,
          correlationId: context.correlationId,
        });
      }
      if (outcome.batchFailed) {
        // The whole call went unanswered: certification is down, so the run stops here.
        failed = true;
        break;
      }
      const last: StaleTag = tags[tags.length - 1]!;
      after = { evaluatedAt: last.evaluatedAt, tagId: last.tagId };
      if (tags.length < RECONCILE_PAGE) break;
    }
    const failedRuns = failed ? (this.#failedRuns.get(market.marketId) ?? 0) + 1 : 0;
    this.#failedRuns.set(market.marketId, failedRuns);
    const line = {
      msg: 'catalog.reconcile-tags',
      code: failed ? 'unavailable' : 'done',
      ...counts,
      skipped,
      marketId: market.marketId,
      correlationId: context.correlationId,
    };
    if (failedRuns >= RECONCILE_ALERT_AFTER) {
      this.#logger.error({ ...line, alert: 'catalog.reconcile-tags.failing', failedRuns });
    } else {
      this.#logger.log(line);
    }
    return ok({ ...counts, skipped });
  }
}
