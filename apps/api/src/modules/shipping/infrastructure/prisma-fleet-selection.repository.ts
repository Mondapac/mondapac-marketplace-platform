import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  ActorId,
  FleetSelectionRepository,
} from '../application/ports/fleet-selection.repository';
import type { CarrierMethod } from '../domain/booking-service';
import { isFleetCode, type FleetCode } from '../domain/fleet';
import {
  parseSelectionRule,
  type FleetSelectionModel,
  type SelectionRule,
} from '../domain/fleet-selection';
import { parseMethod } from '../domain/fleet-selection';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

interface ModelRow {
  readonly id: string;
  readonly name: string;
  readonly rule: unknown;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The stored rule, checked again on the way out; a row that does not parse is skipped. */
function toModel(row: ModelRow): FleetSelectionModel | null {
  const rule = parseSelectionRule(row.rule);
  if (!rule.ok) return null;
  return {
    id: row.id as Id<'FleetSelectionModel'>,
    name: row.name,
    rule: rule.rule,
    version: row.version,
    createdAt: toInstant(row.createdAt),
    updatedAt: toInstant(row.updatedAt),
  };
}

/** The rule as the JSON column takes it (the closed shapes of the domain, plain data). */
const ruleJson = (rule: SelectionRule) => JSON.parse(JSON.stringify(rule)) as object as never;

/**
 * {@link FleetSelectionRepository} on `shipping.fleet_selection_models`,
 * `shipping.fleet_selection_assignments`, `shipping.fleet_reliability` and
 * `shipping.fleet_selection_settings`, scoped by `marketId` in
 * every `where`.
 */
export class PrismaFleetSelectionRepository implements FleetSelectionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listModels(market: MarketContext) {
    const rows = await this.prisma.tx(market).shippingFleetSelectionModel.findMany({
      where: { marketId: market.marketId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toModel).filter((model): model is FleetSelectionModel => model !== null);
  }

  async findModel(market: MarketContext, id: Id<'FleetSelectionModel'>) {
    const row = await this.prisma
      .tx(market)
      .shippingFleetSelectionModel.findFirst({ where: { marketId: market.marketId, id } });
    return row === null ? null : toModel(row);
  }

  /** A name another model of the Market has, in any case (a unique index backs the check). */
  private async nameTaken(market: MarketContext, name: string, except: string | null) {
    const other = await this.prisma.tx(market).shippingFleetSelectionModel.findFirst({
      where: {
        marketId: market.marketId,
        name: { equals: name, mode: 'insensitive' },
        ...(except === null ? {} : { id: { not: except } }),
      },
      select: { id: true },
    });
    return other !== null;
  }

  async insertModel(market: MarketContext, model: FleetSelectionModel, by: ActorId) {
    if (await this.nameTaken(market, model.name, null)) return 'name-taken' as const;
    await this.prisma.tx(market).shippingFleetSelectionModel.create({
      data: {
        id: model.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        name: model.name,
        kind: model.rule.kind,
        rule: ruleJson(model.rule),
        version: model.version,
        createdAt: toDate(model.createdAt),
        createdBy: by,
        updatedAt: toDate(model.updatedAt),
        updatedBy: by,
      },
    });
    return 'inserted' as const;
  }

  async saveModel(
    market: MarketContext,
    model: FleetSelectionModel,
    expectedVersion: number,
    by: ActorId,
  ) {
    if (await this.nameTaken(market, model.name, model.id)) return 'name-taken' as const;
    const updated = await this.prisma.tx(market).shippingFleetSelectionModel.updateMany({
      where: { marketId: market.marketId, id: model.id, version: expectedVersion },
      data: {
        name: model.name,
        kind: model.rule.kind,
        rule: ruleJson(model.rule),
        version: model.version,
        updatedAt: toDate(model.updatedAt),
        updatedBy: by,
      },
    });
    return updated.count === 1 ? ('saved' as const) : ('conflict' as const);
  }

  async assignments(market: MarketContext) {
    const rows = await this.prisma
      .tx(market)
      .shippingFleetSelectionAssignment.findMany({ where: { marketId: market.marketId } });
    const map = new Map<CarrierMethod, Id<'FleetSelectionModel'>>();
    for (const row of rows) {
      const method = parseMethod(row.method);
      if (method !== null && row.modelId !== null) {
        map.set(method, row.modelId as Id<'FleetSelectionModel'>);
      }
    }
    return map;
  }

  async assign(
    market: MarketContext,
    method: CarrierMethod,
    modelId: Id<'FleetSelectionModel'> | null,
    by: ActorId,
    at: Temporal.Instant,
  ) {
    await this.prisma.tx(market).shippingFleetSelectionAssignment.upsert({
      where: { marketId: market.marketId, marketId_method: { marketId: market.marketId, method } },
      create: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        method,
        modelId,
        updatedAt: toDate(at),
        updatedBy: by,
      },
      update: { modelId, updatedAt: toDate(at), updatedBy: by },
    });
  }

  async activeRule(market: MarketContext, method: CarrierMethod): Promise<SelectionRule | null> {
    const assignment = await this.prisma.tx(market).shippingFleetSelectionAssignment.findFirst({
      where: { marketId: market.marketId, method },
      include: { model: true },
    });
    if (assignment?.model == null) return null;
    return toModel(assignment.model)?.rule ?? null;
  }

  async selectionVersion(market: MarketContext) {
    const row = await this.prisma
      .tx(market)
      .shippingFleetSelectionSettings.findFirst({ where: { marketId: market.marketId } });
    return row?.version ?? 0;
  }

  async bumpSelectionVersion(
    market: MarketContext,
    expectedVersion: number,
    by: ActorId,
    at: Temporal.Instant,
  ) {
    const tx = this.prisma.tx(market);
    const version = expectedVersion + 1;
    if (expectedVersion === 0) {
      // The first save: a second one racing it inserts nothing and is a conflict.
      const created = await tx.shippingFleetSelectionSettings.createMany({
        data: [
          {
            marketId: market.marketId,
            tenantId: market.tenantId,
            version,
            updatedAt: toDate(at),
            updatedBy: by,
          },
        ],
        skipDuplicates: true,
      });
      return created.count === 1 ? ('bumped' as const) : ('conflict' as const);
    }
    const updated = await tx.shippingFleetSelectionSettings.updateMany({
      where: { marketId: market.marketId, version: expectedVersion },
      data: { version, updatedAt: toDate(at), updatedBy: by },
    });
    return updated.count === 1 ? ('bumped' as const) : ('conflict' as const);
  }

  async reliabilities(market: MarketContext) {
    const rows = await this.prisma
      .tx(market)
      .shippingFleetReliability.findMany({ where: { marketId: market.marketId } });
    const map = new Map<FleetCode, number>();
    for (const row of rows) if (isFleetCode(row.fleet)) map.set(row.fleet, row.score);
    return map;
  }

  async setReliability(
    market: MarketContext,
    fleet: FleetCode,
    score: number,
    by: ActorId,
    at: Temporal.Instant,
  ) {
    await this.prisma.tx(market).shippingFleetReliability.upsert({
      where: { marketId: market.marketId, marketId_fleet: { marketId: market.marketId, fleet } },
      create: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        fleet,
        score,
        updatedAt: toDate(at),
        updatedBy: by,
      },
      update: { score, updatedAt: toDate(at), updatedBy: by },
    });
  }
}
