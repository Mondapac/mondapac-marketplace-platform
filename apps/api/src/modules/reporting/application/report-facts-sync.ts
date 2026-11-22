import { Logger } from '@nestjs/common';
import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Clock, MarketContext, Result } from '@mondapac/shared-kernel';
import type { EventDelivery } from '../../../platform/events/event-delivery';
import { TransactionConflictError } from '../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { FactRecorder } from './fact-recorder';
import {
  SOURCE_BATCH,
  type RefundSource,
  type ReportSources,
  type SellerOrderSource,
  type SellerOrderSourceRef,
  type SourceUnavailable,
  type SourceWindow,
} from './ports/report-sources';

const logger = new Logger('ReportFactsSync');

/** How far back the nightly reconcile reads again (design section 4: seven days). */
export const RECONCILE_DAYS = 7;

export interface ReportFactsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly sources: ReportSources;
  readonly recorder: FactRecorder;
  readonly clock: Clock;
}

/** What one event asks reporting to read again. */
export interface RecordRequest {
  readonly sellerOrders: readonly SellerOrderSourceRef[];
  readonly refundIds: readonly string[];
}

export type ReportFactsFailure = SourceUnavailable | { readonly code: 'validation.failed' };

export interface RecordCounts {
  readonly sellerOrders: number;
  readonly refunds: number;
}

interface ReadFacts {
  readonly sellerOrders: readonly SellerOrderSource[];
  readonly refunds: readonly RefundSource[];
}

/**
 * Reads the owners' facts, outside any unit (a facade opens its own read-only unit). A seller order
 * that was never paid is left out: it never counts in a rollup (a cancellation before payment is
 * not a cancelled sale), so it is not recorded.
 */
async function readFacts(
  deps: ReportFactsDependencies,
  context: CallContext,
  request: RecordRequest,
): Promise<Result<ReadFacts, SourceUnavailable>> {
  const sellerOrders =
    request.sellerOrders.length === 0
      ? ok([])
      : await deps.sources.sellerOrders(context, request.sellerOrders);
  if (!sellerOrders.ok) return sellerOrders;
  const refunds =
    request.refundIds.length === 0
      ? ok([])
      : await deps.sources.refunds(context, request.refundIds);
  if (!refunds.ok) return refunds;
  return ok({
    sellerOrders: sellerOrders.value.filter((source) => source.order.paidAt !== null),
    refunds: refunds.value,
  });
}

/** Inside the caller's SERIALIZABLE unit (Mojtaba F1 of PR 9): the seller orders, then refunds. */
async function writeFacts(
  deps: ReportFactsDependencies,
  market: MarketContext,
  facts: ReadFacts,
): Promise<RecordCounts> {
  await deps.recorder.recordBatch(market, facts);
  return { sellerOrders: facts.sellerOrders.length, refunds: facts.refunds.length };
}

/**
 * The event worker: reads what the event names again from its owners, then records it once per
 * delivery in a serializable unit (the inbox row in the same unit). A fact is the owner's state as
 * read, not a delta, so a late, repeated or out-of-order event converges. A refused or failed read
 * is a failure, and the delivery is retried; a fact the recorder refuses (another currency, goods
 * that do not add up, a changed identity) throws, so it is retried and then dead-lettered.
 */
export async function recordFromEvent(
  deps: ReportFactsDependencies,
  context: CallContext,
  delivery: EventDelivery,
  request: RecordRequest,
): Promise<Result<RecordCounts & { readonly handled: boolean }, ReportFactsFailure>> {
  if (request.sellerOrders.length > SOURCE_BATCH || request.refundIds.length > SOURCE_BATCH) {
    return err({ code: 'validation.failed' });
  }
  const facts = await readFacts(deps, context, request);
  if (!facts.ok) return facts;
  const done = await deps.unitOfWork.runOnce(
    context.market,
    delivery,
    async () => ok(await writeFacts(deps, context.market, facts.value)),
    { isolation: 'serializable' },
  );
  if (!done.ok) return done;
  return done.value.handled
    ? ok({ handled: true, ...done.value.value })
    : ok({ handled: false, sellerOrders: 0, refunds: 0 });
}

export interface ReconcileCounts extends RecordCounts {
  /** Write batches that failed; logged and left to the next run. */
  readonly failedBatches: number;
}

/** The most facts one reconcile unit writes. */
export const WRITE_BATCH = 25;
/** Rounds of a unit that keeps conflicting (each round is the unit of work's own retries). */
const CONFLICT_ROUNDS = 3;
const CONFLICT_PAUSE_MS = 200;
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Reads every seller order and refund of the window again, one page of at most
 * {@link SOURCE_BATCH} at a time, and records each page in serializable units of at most
 * {@link WRITE_BATCH} facts: the nightly reconcile (the last {@link RECONCILE_DAYS} days) and the
 * history backfill (no start). Small units keep a serialization conflict with the event worker
 * rare (Mojtaba, PR 9: low concurrency); a unit that still conflicts after its own retries is tried
 * again after a pause. Safe to run twice or to overlap a late run of itself, since every write
 * replaces. A batch the recorder refuses is logged and skipped, so one bad fact does not hold the
 * rest back; a failed read stops the run, which the next run repeats.
 */
export async function reconcileWindow(
  deps: ReportFactsDependencies,
  context: CallContext,
  window: SourceWindow,
): Promise<Result<ReconcileCounts, SourceUnavailable>> {
  let sellerOrders = 0;
  let refunds = 0;
  let failedBatches = 0;
  const write = async (batch: ReadFacts): Promise<void> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const counts = await deps.unitOfWork.run(
          context.market,
          async () => ok(await writeFacts(deps, context.market, batch)),
          { isolation: 'serializable' },
        );
        if (counts.ok) {
          sellerOrders += counts.value.sellerOrders;
          refunds += counts.value.refunds;
        }
        return;
      } catch (error) {
        if (error instanceof TransactionConflictError && attempt < CONFLICT_ROUNDS) {
          await pause(CONFLICT_PAUSE_MS * attempt);
          continue;
        }
        failedBatches += 1;
        logger.error({
          msg: 'reporting.reconcile-batch-failed',
          marketId: context.market.marketId,
          correlationId: context.correlationId,
          sellerOrderIds: batch.sellerOrders.map((source) => source.order.sellerOrderId),
          refundIds: batch.refunds.map((source) => source.refund.refundId),
          error: error instanceof Error ? error.name : 'unknown',
        });
        return;
      }
    }
  };
  const record = async (request: RecordRequest): Promise<boolean> => {
    const facts = await readFacts(deps, context, request);
    if (!facts.ok) return false;
    for (let start = 0; start < facts.value.sellerOrders.length; start += WRITE_BATCH) {
      await write({
        sellerOrders: facts.value.sellerOrders.slice(start, start + WRITE_BATCH),
        refunds: [],
      });
    }
    for (let start = 0; start < facts.value.refunds.length; start += WRITE_BATCH) {
      await write({
        sellerOrders: [],
        refunds: facts.value.refunds.slice(start, start + WRITE_BATCH),
      });
    }
    return true;
  };

  let after: string | null = null;
  for (;;) {
    const page = await deps.sources.changedSellerOrders(context, window, after, SOURCE_BATCH);
    if (!page.ok) return page;
    if (page.value.items.length > 0) {
      const read = await record({ sellerOrders: page.value.items, refundIds: [] });
      if (!read) return err(unavailable('ordering seller orders'));
    }
    if (page.value.next === null) break;
    after = page.value.next;
  }
  after = null;
  for (;;) {
    const page = await deps.sources.succeededRefunds(context, window, after, SOURCE_BATCH);
    if (!page.ok) return page;
    if (page.value.items.length > 0) {
      const read = await record({ sellerOrders: [], refundIds: page.value.items });
      if (!read) return err(unavailable('ordering refunds'));
    }
    if (page.value.next === null) break;
    after = page.value.next;
  }
  return ok({ sellerOrders, refunds, failedBatches });
}

/** The nightly reconcile's window: the last {@link RECONCILE_DAYS} days up to now. */
export function reconcileWindowAt(now: Temporal.Instant): SourceWindow {
  return { from: now.subtract(Temporal.Duration.from({ hours: 24 * RECONCILE_DAYS })), to: now };
}

const unavailable = (cause: string): SourceUnavailable => ({
  code: 'reporting.source-unavailable',
  cause,
});
