import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { BackfillProgress, BackfillProgressStore } from './ports/backfill-progress-store';
import type { SourceUnavailable } from './ports/report-sources';
import {
  addCounts,
  FACT_KINDS,
  NO_COUNTS,
  writePage,
  type ReconcileCounts,
  type ReportFactsDependencies,
} from './report-facts-sync';

export interface BackfillDependencies extends ReportFactsDependencies {
  readonly progress: BackfillProgressStore;
}

/** The most pages one run writes, over both kinds: 2,000 facts, well inside the job's ten minutes. */
export const BACKFILL_PAGES_PER_RUN = 20;

export interface BackfillCounts extends ReconcileCounts {
  /** Pages written by this run. */
  readonly pages: number;
  /** True when both kinds are known to be read to the end (now or by an earlier run). */
  readonly finished: boolean;
}

/**
 * The history backfill (dashboards upgrade phase 3, PR 12): reads every seller order and refund up
 * to the moment the backfill started, page by page in id order ({@link writePage}), and saves the
 * cursor after each page in its own unit, so a run that stops, fails or times out goes on from the
 * last page written. At most `maxPages` pages a run, one after the other (low concurrency beside
 * the event worker). Later facts come from the worker and the nightly reconcile.
 *
 * Idempotent: every fact write replaces, and the cursor only moves on from where it was read
 * (`advance`), so a late run that overlaps another writes the same page again at most and then
 * stops. A failed read stops the run with the cursor where it was; a fact the recorder refuses is
 * logged, counted on the progress (`failed_facts`) and skipped. Once both kinds are finished a run
 * does nothing but read the two progress rows.
 */
export async function backfillHistory(
  deps: BackfillDependencies,
  context: CallContext,
  maxPages: number = BACKFILL_PAGES_PER_RUN,
): Promise<Result<BackfillCounts, SourceUnavailable>> {
  const market = context.market;
  const until = deps.clock.now();
  let counts = NO_COUNTS;
  let pages = 0;
  let finished = true;
  for (const kind of FACT_KINDS) {
    const started = await deps.unitOfWork.run(market, async () =>
      ok(await deps.progress.start(market, kind, until)),
    );
    if (!started.ok) return started;
    let progress: BackfillProgress | null = started.value;
    while (progress !== null && progress.finishedAt === null && pages < maxPages) {
      const from: BackfillProgress = progress;
      const page = await writePage(deps, context, kind, { from: null, to: from.until }, from.after);
      if (!page.ok) return page;
      pages += 1;
      counts = addCounts(counts, page.value.counts);
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
      progress = saved.value;
    }
    // Out of pages, or overtaken by another run: the next run goes on (and reads the rest).
    if (progress === null || progress.finishedAt === null || pages >= maxPages) {
      finished = progress !== null && progress.finishedAt !== null && kind === 'refunds';
      break;
    }
  }
  return ok({ ...counts, pages, finished });
}
