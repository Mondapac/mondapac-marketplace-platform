import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import type { EventDelivery } from '../../../platform/events/event-delivery';
import { TransactionConflictError } from '../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { LedgerRecorder } from './ledger-recorder';
import {
  LEDGER_BACKFILL_KIND,
  type BackfillProgress,
  type BackfillProgressStore,
} from './ports/backfill-progress-store';
import { LEDGER_PAGE, type LedgerSourceEntry, type LedgerSources } from './ports/ledger-sources';
import type { SourceUnavailable } from './ports/report-sources';
import { isFactRefusal } from './report-facts-sync';

const logger = new Logger('LedgerFactsSync');

export interface LedgerFactsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly sources: LedgerSources;
  readonly recorder: LedgerRecorder;
  readonly clock: Clock;
}

export interface LedgerBackfillDependencies extends LedgerFactsDependencies {
  readonly progress: BackfillProgressStore;
}

export type LedgerFactsFailure = SourceUnavailable | { readonly code: 'validation.failed' };

/** Rounds of a unit that keeps conflicting (each round is the unit of work's own retries). */
const CONFLICT_ROUNDS = 3;
const CONFLICT_PAUSE_MS = 200;
/** A backfill unit's timeout (the unit of work allows up to 30 s). */
const BACKFILL_UNIT_MS = 15_000;
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The ledger event worker (`commission-payouts.ledger-recorded.v1`): reads every reportable row of
 * the posting's seller order again through commission-payouts' facade, outside any unit, then
 * records them once per delivery in a serializable unit (the inbox row in the same unit). Reading
 * the whole seller order, not the one posting, makes a late, repeated or out-of-order event
 * converge and fills a row an earlier lost event missed. A failed read is a failure (retried); a
 * row the recorder refuses throws (retried, then dead-lettered).
 */
export async function recordLedgerFromEvent(
  deps: LedgerFactsDependencies,
  context: CallContext,
  delivery: EventDelivery,
  sellerOrderId: string,
): Promise<Result<{ readonly handled: boolean; readonly entries: number }, LedgerFactsFailure>> {
  const id = parseId<'SellerOrder'>(typeof sellerOrderId === 'string' ? sellerOrderId : '');
  if (!id.ok) return err({ code: 'validation.failed' });
  const read = await deps.sources.entriesOf(context, [id.value]);
  if (!read.ok) return read;
  const entries = read.value;
  const done = await deps.unitOfWork.runOnce(
    context.market,
    delivery,
    async () => ok(await deps.recorder.record(context.market, entries)),
    { isolation: 'serializable' },
  );
  if (!done.ok) return done;
  return ok(
    done.value.handled
      ? { handled: true, entries: done.value.value }
      : { handled: false, entries: 0 },
  );
}

/** The name the ledger backfill's logs carry (its job's name). */
const LEDGER_BACKFILL_JOB = 'reporting.backfill-ledger';
/** The most pages one run writes: 4,000 rows. */
export const LEDGER_BACKFILL_PAGES_PER_RUN = 20;
/** A run starts no new page after this long, on the injected clock (as the sales backfill). */
export const LEDGER_BACKFILL_BUDGET_MS = 60_000;

export interface LedgerBackfillLimits {
  readonly maxPages: number;
  readonly budgetMs: number;
}

const DEFAULT_LIMITS: LedgerBackfillLimits = {
  maxPages: LEDGER_BACKFILL_PAGES_PER_RUN,
  budgetMs: LEDGER_BACKFILL_BUDGET_MS,
};

export interface LedgerBackfillCounts {
  readonly entries: number;
  /** Rows the recorder or the database refused: logged by id, counted and passed over. */
  readonly failedFacts: number;
  readonly pages: number;
  readonly finished: boolean;
}

interface Attempt {
  readonly written: boolean;
  readonly refused: boolean;
  readonly error: string;
}

/** One serializable unit; a conflict is tried again after a pause. */
async function attempt(
  deps: LedgerFactsDependencies,
  context: CallContext,
  entries: readonly LedgerSourceEntry[],
): Promise<Attempt> {
  for (let round = 1; ; round += 1) {
    try {
      await deps.unitOfWork.run(
        context.market,
        async () => ok(await deps.recorder.record(context.market, entries)),
        { isolation: 'serializable', timeoutMs: BACKFILL_UNIT_MS },
      );
      return { written: true, refused: false, error: '' };
    } catch (error) {
      if (error instanceof TransactionConflictError && round < CONFLICT_ROUNDS) {
        await pause(CONFLICT_PAUSE_MS * round);
        continue;
      }
      return {
        written: false,
        refused: isFactRefusal(error),
        error: error instanceof Error ? error.name : 'unknown',
      };
    }
  }
}

/**
 * Writes one page in one unit; when it fails for another reason than a conflict, row by row, so a
 * refused row does not hold the good ones back. The refused rows are logged by id and counted; a
 * row that failed for a reason that may pass (a conflict after every round, a timeout) is counted
 * as transient, and the caller must not move the cursor past the page.
 */
async function writeLedgerPage(
  deps: LedgerFactsDependencies,
  context: CallContext,
  entries: readonly LedgerSourceEntry[],
): Promise<{ readonly written: number; readonly refused: number; readonly transient: number }> {
  if (entries.length === 0) return { written: 0, refused: 0, transient: 0 };
  const whole = await attempt(deps, context, entries);
  if (whole.written) return { written: entries.length, refused: 0, transient: 0 };
  let written = 0;
  let refused = 0;
  let transient = 0;
  for (const entry of entries) {
    const one = entries.length === 1 ? whole : await attempt(deps, context, [entry]);
    if (one.written) {
      written += 1;
      continue;
    }
    if (one.refused) refused += 1;
    else transient += 1;
    logger.error({
      msg: 'reporting.fact-write-failed',
      job: LEDGER_BACKFILL_JOB,
      kind: LEDGER_BACKFILL_KIND,
      refused: one.refused,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
      entryIds: [entry.entryId],
      error: one.error,
    });
  }
  return { written, refused, transient };
}

/**
 * The ledger history backfill (dashboards v2, phase 1, PR 4): reads every reportable ledger row
 * recorded before the moment it first started (its own `until` on the `ledger` row of
 * `reporting.backfill_progress`), in entry id order, pages of {@link LEDGER_PAGE}, and saves the
 * cursor after each page in its own unit, so a run that stops, fails or times out goes on from the
 * last page saved. Rows recorded after `until` come from the event worker. At most `maxPages`
 * pages and `budgetMs` a run.
 *
 * Idempotent: a fact stored already is left as it is, and the cursor only moves on from where it
 * was read (`advance`), so an overlapping run writes one page again at most and then stops. A
 * failed read, a cursor that does not move on, or a row that failed for a reason that may pass
 * stops the run before the cursor moves. A refused row is counted on the progress and passed
 * over; the run reports it, and a reset (delete the `ledger` row) after the fix brings it in.
 */
export async function backfillLedger(
  deps: LedgerBackfillDependencies,
  context: CallContext,
  limits: LedgerBackfillLimits = DEFAULT_LIMITS,
): Promise<Result<LedgerBackfillCounts, SourceUnavailable>> {
  const market = context.market;
  const startedAt = deps.clock.now();
  const started = await deps.unitOfWork.run(market, async () =>
    ok(await deps.progress.startLedger(market, startedAt)),
  );
  if (!started.ok) return started;
  let progress: BackfillProgress<typeof LEDGER_BACKFILL_KIND> = started.value;
  let entries = 0;
  let failedFacts = 0;
  let pages = 0;
  const outOfBudget = () =>
    pages >= limits.maxPages ||
    deps.clock.now().since(startedAt).total({ unit: 'milliseconds' }) >= limits.budgetMs;
  const counts = (finished: boolean): LedgerBackfillCounts => ({
    entries,
    failedFacts,
    pages,
    finished,
  });
  while (progress.finishedAt === null && !outOfBudget()) {
    const from = progress;
    const read = await deps.sources.entriesRecorded(
      context,
      { from: null, to: from.until },
      from.after,
      LEDGER_PAGE,
    );
    if (!read.ok) return read;
    const next = read.value.next;
    if (next !== null && from.after !== null && next <= from.after) {
      return err({ code: 'reporting.source-unavailable', cause: 'commission-payouts cursor' });
    }
    const page = await writeLedgerPage(deps, context, read.value.items);
    entries += page.written;
    failedFacts += page.refused + page.transient;
    if (page.transient > 0) {
      return err({ code: 'reporting.source-unavailable', cause: 'reporting ledger write' });
    }
    const last = read.value.items[read.value.items.length - 1];
    const saved = await deps.unitOfWork.run(market, async () =>
      ok(
        await deps.progress.advance(market, from, {
          after: next ?? (last === undefined ? from.after : last.entryId),
          pages: from.pages + 1,
          failedFacts: from.failedFacts + page.refused,
          finished: next === null,
        }),
      ),
    );
    if (!saved.ok) return saved;
    // Null: another run moved the cursor on meanwhile; it carries on from there.
    if (saved.value === null) return ok(counts(false));
    pages += 1;
    progress = saved.value;
  }
  return ok(counts(progress.finishedAt !== null));
}
