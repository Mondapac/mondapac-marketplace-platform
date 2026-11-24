import { Logger } from '@nestjs/common';
import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Clock, MarketContext, Result } from '@mondapac/shared-kernel';
import type { EventDelivery } from '../../../platform/events/event-delivery';
import { reduceDatabaseError } from '../../../platform/persistence/database-error';
import { TransactionConflictError } from '../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { FactRecorder } from './fact-recorder';
import { ReportingFactConflict } from './ports/fact-store';
import { ReportingLedgerConflict } from './ports/ledger-fact-store';
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
  /** Facts the recorder refused or that could not be written; logged and left to the next run. */
  readonly failedFacts: number;
}

/** The two kinds of fact a window is read for, in the order they are read. */
export const FACT_KINDS = ['seller-orders', 'refunds'] as const;
export type FactKind = (typeof FACT_KINDS)[number];

/** The name the nightly reconcile's logs carry (its job's name). */
const RECONCILE_JOB = 'reporting.reconcile-facts';

/** The most facts one reconcile unit writes. */
export const WRITE_BATCH = 25;
/** Rounds of a unit that keeps conflicting (each round is the unit of work's own retries). */
const CONFLICT_ROUNDS = 3;
const CONFLICT_PAUSE_MS = 200;
/** A reconcile unit's timeout (the unit of work allows up to 30 s). */
const RECONCILE_UNIT_MS = 15_000;
/** The most pages one run reads per kind: 1,000,000 facts, far above a day's volume. */
const MAX_PAGES = 10_000;
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** One page of a window read and recorded: the cursor to go on from, null at the end. */
export interface WrittenPage {
  readonly next: string | null;
  readonly counts: ReconcileCounts;
  /**
   * Of `counts.failedFacts`, those that failed for a reason that may pass (a conflict after every
   * round, a timeout, a lost connection), not because the recorder refused the fact. A caller that
   * moves a cursor past the page must not do so while this is above 0 (Hassan, PR 12 M1).
   */
  readonly transientFacts: number;
}

/** Prisma's codes for a value the database refuses whenever it is written (Mojtaba, PR 12). */
const REFUSING_PRISMA_CODES = new Set(['P2000', 'P2003', 'P2004', 'P2011']);

/**
 * Whether a write failure is the fact itself being refused, so that writing it again gives the
 * same answer: the recorder refusing it (another currency, goods that do not add up, a changed
 * identity), or the database refusing a value (SQLSTATE class 22, data exception, or 23,
 * integrity violation). A timeout, a lost connection or a conflict is not: it may pass.
 */
export function isFactRefusal(error: unknown): boolean {
  if (
    error instanceof ReportingFactConflict ||
    error instanceof ReportingLedgerConflict ||
    error instanceof RangeError ||
    error instanceof TypeError
  ) {
    return true;
  }
  const database = reduceDatabaseError(error);
  if (database === undefined) return false;
  if (database.prismaCode !== undefined && REFUSING_PRISMA_CODES.has(database.prismaCode)) {
    return true;
  }
  const sqlState = database.sqlState ?? '';
  return sqlState.startsWith('22') || sqlState.startsWith('23');
}

/** One page of refs of `kind`, as the request that reads their facts. */
async function readPage(
  deps: ReportFactsDependencies,
  context: CallContext,
  kind: FactKind,
  window: SourceWindow,
  after: string | null,
): Promise<Result<{ next: string | null; request: RecordRequest }, SourceUnavailable>> {
  if (kind === 'seller-orders') {
    const page = await deps.sources.changedSellerOrders(context, window, after, SOURCE_BATCH);
    if (!page.ok) return page;
    return ok({
      next: page.value.next,
      request: { sellerOrders: page.value.items, refundIds: [] },
    });
  }
  const page = await deps.sources.succeededRefunds(context, window, after, SOURCE_BATCH);
  if (!page.ok) return page;
  return ok({ next: page.value.next, request: { sellerOrders: [], refundIds: page.value.items } });
}

/**
 * Reads one page of `kind` in the window after `after` (at most {@link SOURCE_BATCH} facts) and
 * records it in serializable units of at most {@link WRITE_BATCH} facts. Small units keep a
 * serialization conflict with the event worker rare (Mojtaba, PR 9: low concurrency); a unit that
 * still conflicts after its own retries is tried again after a pause. Every write replaces, so a
 * page written twice is harmless. A batch that fails for another reason than a conflict is written
 * again one fact at a time, so a fact the recorder refuses does not hold the good ones of its batch
 * back (Hassan, PR 10b finding 3); only the facts that still fail are logged (with `job` and the
 * kind) and counted, refusals apart from failures that may pass. A failed read, or a cursor that
 * does not move on, is a failure: nothing is skipped past it.
 */
export async function writePage(
  deps: ReportFactsDependencies,
  context: CallContext,
  kind: FactKind,
  window: SourceWindow,
  after: string | null,
  job: string,
): Promise<Result<WrittenPage, SourceUnavailable>> {
  let sellerOrders = 0;
  let refunds = 0;
  let failedFacts = 0;
  let transientFacts = 0;
  /** One unit; a conflict is tried again after a pause. True when written. */
  const attempt = async (
    batch: ReadFacts,
  ): Promise<{ written: boolean; error: string; refused: boolean }> => {
    for (let round = 1; ; round += 1) {
      try {
        const counts = await deps.unitOfWork.run(
          context.market,
          async () => ok(await writeFacts(deps, context.market, batch)),
          // A unit of 25 facts on a busy day can pass the default 5 s (Mojtaba, PR 10b note 3).
          { isolation: 'serializable', timeoutMs: RECONCILE_UNIT_MS },
        );
        if (!counts.ok) return { written: false, error: 'refused', refused: true };
        sellerOrders += counts.value.sellerOrders;
        refunds += counts.value.refunds;
        return { written: true, error: '', refused: false };
      } catch (error) {
        if (error instanceof TransactionConflictError && round < CONFLICT_ROUNDS) {
          await pause(CONFLICT_PAUSE_MS * round);
          continue;
        }
        return {
          written: false,
          error: error instanceof Error ? error.name : 'unknown',
          refused: isFactRefusal(error),
        };
      }
    }
  };
  const failed = (batch: ReadFacts, error: string, refused: boolean): void => {
    failedFacts += 1;
    if (!refused) transientFacts += 1;
    logger.error({
      msg: 'reporting.fact-write-failed',
      job,
      kind,
      refused,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
      sellerOrderIds: batch.sellerOrders.map((source) => source.order.sellerOrderId),
      refundIds: batch.refunds.map((source) => source.refund.refundId),
      error,
    });
  };
  const write = async (batch: ReadFacts): Promise<void> => {
    const whole = await attempt(batch);
    if (whole.written) return;
    if (batch.sellerOrders.length + batch.refunds.length === 1)
      return failed(batch, whole.error, whole.refused);
    const singles: ReadFacts[] = [
      ...batch.sellerOrders.map((source) => ({ sellerOrders: [source], refunds: [] })),
      ...batch.refunds.map((source) => ({ sellerOrders: [], refunds: [source] })),
    ];
    for (const single of singles) {
      const one = await attempt(single);
      if (!one.written) failed(single, one.error, one.refused);
    }
  };

  const read = await readPage(deps, context, kind, window, after);
  if (!read.ok) return read;
  const { next, request } = read.value;
  // A cursor that does not move on stops the run (Hassan, PR 10b finding 2).
  if (next !== null && (next === after || (after !== null && next <= after))) {
    return err(unavailable(`ordering ${kind} cursor`));
  }
  if (request.sellerOrders.length + request.refundIds.length > 0) {
    const facts = await readFacts(deps, context, request);
    if (!facts.ok) return err(unavailable(`ordering ${kind}`));
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
  }
  return ok({ next, counts: { sellerOrders, refunds, failedFacts }, transientFacts });
}

/** Adds two runs' counts. */
export const addCounts = (a: ReconcileCounts, b: ReconcileCounts): ReconcileCounts => ({
  sellerOrders: a.sellerOrders + b.sellerOrders,
  refunds: a.refunds + b.refunds,
  failedFacts: a.failedFacts + b.failedFacts,
});

export const NO_COUNTS: ReconcileCounts = { sellerOrders: 0, refunds: 0, failedFacts: 0 };

/**
 * Reads every seller order and refund of the window again, page by page ({@link writePage}), in one
 * run: the nightly reconcile (the last {@link RECONCILE_DAYS} days). Safe to run twice or to
 * overlap a late run of itself, since every write replaces. A failed read, a cursor that does not
 * move on, or more than {@link MAX_PAGES} pages stops the run, which the next run repeats.
 */
export async function reconcileWindow(
  deps: ReportFactsDependencies,
  context: CallContext,
  window: SourceWindow,
): Promise<Result<ReconcileCounts, SourceUnavailable>> {
  let total = NO_COUNTS;
  for (const kind of FACT_KINDS) {
    let after: string | null = null;
    for (let pages = 1; ; pages += 1) {
      const page = await writePage(deps, context, kind, window, after, RECONCILE_JOB);
      if (!page.ok) return page;
      total = addCounts(total, page.value.counts);
      if (page.value.next === null) break;
      if (pages >= MAX_PAGES) return err(unavailable(`ordering ${kind} cursor`));
      after = page.value.next;
    }
  }
  return ok(total);
}

/** The nightly reconcile's window: the last {@link RECONCILE_DAYS} days up to now. */
export function reconcileWindowAt(now: Temporal.Instant): SourceWindow {
  return { from: now.subtract(Temporal.Duration.from({ hours: 24 * RECONCILE_DAYS })), to: now };
}

const unavailable = (cause: string): SourceUnavailable => ({
  code: 'reporting.source-unavailable',
  cause,
});
