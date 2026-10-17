import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { StrategyRecord, StrategyRepository } from '../application/ports/strategy.repository';
import { paramsFromStored, paramsToConfig } from '../domain/strategy';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

const toRecord = (row: {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly config: unknown;
  readonly active: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): StrategyRecord => {
  const params = paramsFromStored(row.kind, row.config);
  // Only this repository writes the row, through a checked draft: a bad shape means damage, and
  // tax must not be guessed (the caller fails closed).
  if (params === null) throw new Error('tax.stored-strategy-invalid');
  return {
    id: row.id as Id<'TaxStrategy'>,
    name: row.name,
    params,
    active: row.active,
    createdAt: toInstant(row.createdAt),
    updatedAt: toInstant(row.updatedAt),
  };
};

/** {@link StrategyRepository} on `tax.tax_strategies`, scoped by `marketId` in every `where`. */
export class PrismaStrategyRepository implements StrategyRepository {
  constructor(private readonly prisma: PrismaService) {}

  async list(market: MarketContext) {
    const rows = await this.prisma.tx(market).taxStrategy.findMany({
      where: { marketId: market.marketId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return rows.map(toRecord);
  }

  async find(market: MarketContext, id: Id<'TaxStrategy'>) {
    const row = await this.prisma.tx(market).taxStrategy.findFirst({
      where: { marketId: market.marketId, id },
    });
    return row === null ? null : toRecord(row);
  }

  async findActive(market: MarketContext) {
    const row = await this.prisma.tx(market).taxStrategy.findFirst({
      where: { marketId: market.marketId, active: true },
    });
    return row === null ? null : toRecord(row);
  }

  async findForUpdate(market: MarketContext, id: Id<'TaxStrategy'>) {
    // A same-value update takes the row lock until the unit ends (the guarded client sends no raw
    // SQL); the read after it sees what was committed before the lock was granted.
    const first = await this.find(market, id);
    if (first === null) return null;
    await this.prisma.tx(market).taxStrategy.updateMany({
      where: { marketId: market.marketId, id },
      data: { updatedAt: toDate(first.updatedAt) },
    });
    return this.find(market, id);
  }

  async insert(
    market: MarketContext,
    record: Parameters<StrategyRepository['insert']>[1],
  ): Promise<void> {
    await this.prisma.tx(market).taxStrategy.create({
      data: {
        id: record.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        name: record.name,
        kind: record.params.kind,
        config: paramsToConfig(record.params) as object,
        active: false,
        createdAt: toDate(record.createdAt),
        updatedAt: toDate(record.createdAt),
        updatedBy: record.updatedBy,
      },
    });
  }

  async update(
    market: MarketContext,
    record: Parameters<StrategyRepository['update']>[1],
  ): Promise<void> {
    await this.prisma.tx(market).taxStrategy.updateMany({
      where: { marketId: market.marketId, id: record.id },
      data: {
        name: record.name,
        kind: record.params.kind,
        config: paramsToConfig(record.params) as object,
        updatedAt: toDate(record.updatedAt),
        updatedBy: record.updatedBy,
      },
    });
  }

  async deactivateAll(
    market: MarketContext,
    stamp: Parameters<StrategyRepository['deactivateAll']>[1],
  ): Promise<boolean> {
    const changed = await this.prisma.tx(market).taxStrategy.updateMany({
      where: { marketId: market.marketId, active: true },
      data: { active: false, updatedAt: toDate(stamp.updatedAt), updatedBy: stamp.updatedBy },
    });
    return changed.count > 0;
  }

  async activate(
    market: MarketContext,
    id: Id<'TaxStrategy'>,
    stamp: Parameters<StrategyRepository['deactivateAll']>[1],
  ): Promise<void> {
    await this.prisma.tx(market).taxStrategy.updateMany({
      where: { marketId: market.marketId, id },
      data: { active: true, updatedAt: toDate(stamp.updatedAt), updatedBy: stamp.updatedBy },
    });
  }

  async remove(market: MarketContext, id: Id<'TaxStrategy'>): Promise<boolean> {
    const removed = await this.prisma.tx(market).taxStrategy.deleteMany({
      where: { marketId: market.marketId, id },
    });
    return removed.count > 0;
  }
}
