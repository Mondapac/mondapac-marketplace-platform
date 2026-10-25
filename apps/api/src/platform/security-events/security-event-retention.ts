import { Logger } from '@nestjs/common';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { Clock, MarketContext } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../scheduler/job-registry';
import type { UnitOfWork } from '../unit-of-work/unit-of-work';

/**
 * SOC decision T6 (2026-10-25): security events stay 90 days in `platform.security_events`, then
 * 12 months in `platform.security_events_archive`, then they are deleted. In hours (90 and 365
 * days), not days or months: an Instant has no calendar. The database refuses to delete a younger row (floors of 89 and 454
 * days, one day under these for clock skew), so these values can only grow.
 */
export const SECURITY_EVENTS_HOT = Temporal.Duration.from({ hours: 90 * 24 });
export const SECURITY_EVENTS_ARCHIVED = Temporal.Duration.from({ hours: 365 * 24 });

/** Rows per unit, and units per run and table, so a run stays bounded (P 7). */
export const RETENTION_BATCH = 500;
export const RETENTION_MAX_BATCHES = 40;

export const SECURITY_EVENTS_RETENTION_JOB = 'platform.security-events-retention';

/**
 * The two statements of the retention job, each in the caller's read-write unit
 * (platform/persistence/audit/; the tables are reserved to that folder). Bound only by
 * `SecurityEventsModule`; never exported.
 */
export interface SecurityEventStore {
  /**
   * Copies up to `limit` events that occurred before `before` into the archive (a row already
   * there is kept as it is) and deletes them from `security_events`; answers how many moved.
   */
  archive(
    market: MarketContext,
    before: Temporal.Instant,
    archivedAt: Temporal.Instant,
    limit: number,
  ): Promise<number>;

  /** Deletes up to `limit` archived events that occurred before `before`; answers how many. */
  purgeArchive(market: MarketContext, before: Temporal.Instant, limit: number): Promise<number>;
}

export const SECURITY_EVENT_STORE = Symbol('SECURITY_EVENT_STORE');

export interface RetentionReport {
  readonly archived: number;
  readonly purged: number;
}

/**
 * The retention of one Market's security events: archive what is older than 90 days, then
 * delete archived rows older than 90 + 365 days. Each batch is one unit; a run stops at the
 * first short batch or after {@link RETENTION_MAX_BATCHES} per table, and the next tick goes
 * on. Safe to run twice and concurrently: a row archived twice is kept once and a deleted row
 * is not deleted again.
 */
export class SecurityEventRetention {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly store: SecurityEventStore,
    private readonly clock: Clock,
  ) {}

  async run(market: MarketContext): Promise<RetentionReport> {
    const now = this.clock.now();
    const hotBefore = now.subtract(SECURITY_EVENTS_HOT);
    const archiveBefore = hotBefore.subtract(SECURITY_EVENTS_ARCHIVED);
    const archived = await this.#batches(market, () =>
      this.store.archive(market, hotBefore, now, RETENTION_BATCH),
    );
    const purged = await this.#batches(market, () =>
      this.store.purgeArchive(market, archiveBefore, RETENTION_BATCH),
    );
    return { archived, purged };
  }

  async #batches(market: MarketContext, batch: () => Promise<number>): Promise<number> {
    let total = 0;
    for (let index = 0; index < RETENTION_MAX_BATCHES; index += 1) {
      const result = await this.unitOfWork.run(market, async () => ok(await batch()));
      if (!result.ok) break;
      total += result.value;
      if (result.value < RETENTION_BATCH) break;
    }
    return total;
  }
}

/**
 * `platform.security-events-retention`: every hour, per hosted Market, with the scheduler's
 * system context. Only the worker role runs jobs.
 */
export function securityEventsRetentionJob(retention: SecurityEventRetention): JobDefinition {
  const logger = new Logger('SecurityEventsRetentionJob');
  return {
    name: SECURITY_EVENTS_RETENTION_JOB,
    every: Temporal.Duration.from({ hours: 1 }),
    maxRunMs: 300_000,
    async run(context: JobContext): Promise<void> {
      const report = await retention.run(context.market);
      if (report.archived + report.purged > 0) {
        logger.log({
          msg: SECURITY_EVENTS_RETENTION_JOB,
          marketId: context.market.marketId,
          correlationId: context.correlationId,
          archived: report.archived,
          purged: report.purged,
        });
      }
    },
  };
}
