import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { BackfillProgress, BackfillProgressStore } from './ports/backfill-progress-store';
import type { FactStore } from './ports/fact-store';
import { SOURCE_BATCH, type SourceUnavailable } from './ports/report-sources';
import {
  addCounts,
  NO_COUNTS,
  recordPage,
  writePage,
  type ReconcileCounts,
  type ReportFactsDependencies,
  type WrittenPage,
} from './report-facts-sync';

export interface BackfillDependencies extends ReportFactsDependencies {
  readonly progress: BackfillProgressStore;
  /**
   * reporting's own facts, read by the `delivery` and `buyer-first` passes for the rows still
   * without their columns.
   */
  readonly facts: FactStore;
}

/** The name the backfill's logs carry (its job's name). */
const BACKFILL_JOB = 'reporting.backfill-history';

/** The most pages one run writes, over both kinds: 2,000 facts. */
export const BACKFILL_PAGES_PER_RUN = 20;
/**
 * A run starts no new page after this long, measured on the injected clock, so it leaves the
 * worker's long-job lane to the imports and reindexes (Mojtaba, PR 12 finding 1).
 */
export const BACKFILL_RUN_BUDGET_MS = 60_000;

export interface BackfillLimits {
  readonly maxPages: number;
  readonly budgetMs: number;
}

const DEFAULT_LIMITS: BackfillLimits = {
  maxPages: BACKFILL_PAGES_PER_RUN,
  budgetMs: BACKFILL_RUN_BUDGET_MS,
};

export interface BackfillCounts extends ReconcileCounts {
  /** Pages written and saved by this run. */
  readonly pages: number;
  /** True when every kind is read to the end (now or by an earlier run). */
  readonly finished: boolean;
}

/**
 * The history backfill (dashboards upgrade phase 3, PR 12): reads every seller order and refund up
 * to the moment the backfill started, page by page in id order ({@link writePage}), and saves the
 * cursor after each page in its own unit, so a run that stops, fails or times out goes on from the
 * last page saved. Every kind shares the window end fixed at the first start. At most
 * `maxPages` pages and `budgetMs` a run, one page after the other (low concurrency beside the
 * event worker). Later facts come from the worker and the nightly reconcile.
 *
 * Idempotent: every fact write replaces, and the cursor only moves on from where it was read
 * (`advance`), so a late run that overlaps another writes the same page again at most and then
 * stops. A failed read, or a fact that failed for a reason that may pass (a conflict after every
 * round, a timeout), stops the run before the cursor moves, so the next run writes that page
 * again (Hassan, PR 12 M1). A fact the recorder refuses is logged by id, counted on the progress
 * (`failed_facts`) and passed over; the run reports it, and a reset after the fix brings it in.
 * Once every kind is finished a run only reads the progress rows.
 */
export async function backfillHistory(
  deps: BackfillDependencies,
  context: CallContext,
  limits: BackfillLimits = DEFAULT_LIMITS,
): Promise<Result<BackfillCounts, SourceUnavailable>> {
  const market = context.market;
  const startedAt = deps.clock.now();
  const started = await deps.unitOfWork.run(market, async () =>
    ok(await deps.progress.startAll(market, startedAt)),
  );
  if (!started.ok) return started;
  let counts = NO_COUNTS;
  let pages = 0;
  const outOfBudget = () =>
    pages >= limits.maxPages ||
    deps.clock.now().since(startedAt).total({ unit: 'milliseconds' }) >= limits.budgetMs;
  for (const initial of started.value) {
    let progress: BackfillProgress | null = initial;
    while (progress !== null && progress.finishedAt === null && !outOfBudget()) {
      const from: BackfillProgress = progress;
      const page =
        from.kind === 'delivery' || from.kind === 'buyer-first'
          ? await missingPage(deps, context, from.kind, from.after)
          : await writePage(
              deps,
              context,
              from.kind,
              { from: null, to: from.until },
              from.after,
              BACKFILL_JOB,
            );
      if (!page.ok) return page;
      counts = addCounts(counts, page.value.counts);
      if (page.value.transientFacts > 0) {
        return err({
          code: 'reporting.source-unavailable',
          cause: `reporting ${from.kind} write`,
        });
      }
      const next = page.value.next;
      const saved = await deps.unitOfWork.run(market, async () =>
        ok(
          await deps.progress.advance(market, from, {
            after: next ?? from.after,
            pages: from.pages + 1,
            failedFacts: from.failedFacts + page.value.counts.failedFacts,
            finished: next === null,
          }),
        ),
      );
      if (!saved.ok) return saved;
      // Null: another run moved the cursor on meanwhile; it carries on from there.
      if (saved.value === null) return ok({ ...counts, pages, finished: false });
      pages += 1;
      progress = saved.value;
    }
    if (progress === null || progress.finishedAt === null) {
      return ok({ ...counts, pages, finished: false });
    }
  }
  return ok({ ...counts, pages, finished: true });
}

/**
 * One page of the `delivery` or the `buyer-first` pass (dashboards v2): the seller orders reporting
 * recorded before the delivery columns (no method), or paid ones without the buyer-first flags,
 * after `after` in id order (reporting's own table, read in a read-only unit), read again from their
 * owners and recorded through the same writer as the other kinds. A value the owner cannot tell (a
 * state shipping cannot place; flags of an order paid before ordering recorded them) stays null and
 * the pass moves on, so it ends. Rows recorded after the pass are written with the columns by the
 * worker; a flag already known is kept as it was (`keepKnownInstants`).
 */
async function missingPage(
  deps: BackfillDependencies,
  context: CallContext,
  kind: 'delivery' | 'buyer-first',
  after: string | null,
): Promise<Result<WrittenPage, SourceUnavailable>> {
  const read = await deps.unitOfWork.run(
    context.market,
    async () =>
      ok(
        kind === 'delivery'
          ? await deps.facts.sellerOrdersMissingDelivery(context.market, after, SOURCE_BATCH)
          : await deps.facts.sellerOrdersMissingBuyerFirst(context.market, after, SOURCE_BATCH),
      ),
    { readOnly: true },
  );
  if (!read.ok) return read;
  return recordPage(
    deps,
    context,
    kind,
    after,
    {
      next: read.value.next,
      request: {
        sellerOrders: read.value.items.map((item) => ({
          orderId: item.orderId,
          sellerOrderId: item.sellerOrderId,
        })),
        refundIds: [],
      },
    },
    BACKFILL_JOB,
  );
}
