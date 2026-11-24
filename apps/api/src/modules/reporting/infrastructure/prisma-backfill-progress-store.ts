import type { MarketContext } from '@mondapac/shared-kernel';
import { Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import {
  LEDGER_BACKFILL_KIND,
  type BackfillKind,
  type BackfillProgress,
  type BackfillProgressStore,
  type BackfillStep,
} from '../application/ports/backfill-progress-store';
import { FACT_KINDS } from '../application/report-facts-sync';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

interface ProgressRow {
  readonly kind: string;
  readonly until: Date;
  readonly after: string | null;
  readonly pages: number;
  readonly failedFacts: number;
  readonly finishedAt: Date | null;
}

const toProgress = <K extends BackfillKind>(
  row: ProgressRow,
  kinds: readonly K[],
): BackfillProgress<K> => {
  const kind = kinds.find((known) => known === row.kind);
  if (kind === undefined) throw new Error(`reporting.backfill_progress: unknown kind ${row.kind}`);
  return {
    kind,
    until: toInstant(row.until),
    after: row.after,
    pages: row.pages,
    failedFacts: row.failedFacts,
    finishedAt: row.finishedAt === null ? null : toInstant(row.finishedAt),
  };
};

/**
 * {@link BackfillProgressStore} on `reporting.backfill_progress`, through `PrismaService.tx(market)`
 * with `marketId` in every `where`. The application role may update only the cursor columns.
 */
export class PrismaBackfillProgressStore implements BackfillProgressStore {
  constructor(
    private readonly prisma: PrismaService,
    private readonly now: () => Temporal.Instant,
  ) {}

  async startAll(
    market: MarketContext,
    until: Temporal.Instant,
  ): Promise<readonly BackfillProgress[]> {
    const client = this.prisma.tx(market);
    const read = async () =>
      (
        await client.reportingBackfillProgress.findMany({
          // The sales kinds only: the ledger backfill has its own row and window end.
          where: { marketId: market.marketId, kind: { in: [...FACT_KINDS] } },
        })
      )
        .map((row) => toProgress(row, FACT_KINDS))
        .sort((a, b) => FACT_KINDS.indexOf(a.kind) - FACT_KINDS.indexOf(b.kind));
    const stored = await read();
    if (stored.length === FACT_KINDS.length) return stored;
    const now = toDate(this.now());
    // `ON CONFLICT DO NOTHING`: a concurrent or earlier start keeps its own `until`.
    await client.reportingBackfillProgress.createMany({
      data: FACT_KINDS.map((kind) => ({
        marketId: market.marketId,
        tenantId: market.tenantId,
        kind,
        until: toDate(until),
        after: null,
        pages: 0,
        failedFacts: 0,
        startedAt: now,
        updatedAt: now,
        finishedAt: null,
      })),
      skipDuplicates: true,
    });
    const started = await read();
    if (started.length !== FACT_KINDS.length) {
      throw new Error('reporting.backfill_progress: rows not written');
    }
    return started;
  }

  async startLedger(
    market: MarketContext,
    until: Temporal.Instant,
  ): Promise<BackfillProgress<typeof LEDGER_BACKFILL_KIND>> {
    const client = this.prisma.tx(market);
    const where = { marketId: market.marketId, kind: LEDGER_BACKFILL_KIND };
    const stored = await client.reportingBackfillProgress.findFirst({ where });
    if (stored !== null) return toProgress(stored, [LEDGER_BACKFILL_KIND]);
    const now = toDate(this.now());
    // `ON CONFLICT DO NOTHING`: a concurrent start keeps its own `until`.
    await client.reportingBackfillProgress.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          kind: LEDGER_BACKFILL_KIND,
          until: toDate(until),
          after: null,
          pages: 0,
          failedFacts: 0,
          startedAt: now,
          updatedAt: now,
          finishedAt: null,
        },
      ],
      skipDuplicates: true,
    });
    const started = await client.reportingBackfillProgress.findFirst({ where });
    if (started === null) throw new Error('reporting.backfill_progress: ledger row not written');
    return toProgress(started, [LEDGER_BACKFILL_KIND]);
  }

  async advance<K extends BackfillKind>(
    market: MarketContext,
    from: BackfillProgress<K>,
    to: BackfillStep,
  ): Promise<BackfillProgress<K> | null> {
    const client = this.prisma.tx(market);
    const now = toDate(this.now());
    const moved = await client.reportingBackfillProgress.updateMany({
      where: {
        marketId: market.marketId,
        kind: from.kind,
        after: from.after,
        pages: from.pages,
        finishedAt: null,
      },
      data: {
        after: to.after,
        pages: to.pages,
        failedFacts: to.failedFacts,
        updatedAt: now,
        finishedAt: to.finished ? now : null,
      },
    });
    if (moved.count !== 1) return null;
    return {
      kind: from.kind,
      until: from.until,
      after: to.after,
      pages: to.pages,
      failedFacts: to.failedFacts,
      finishedAt: to.finished ? toInstant(now) : null,
    };
  }
}
