import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { StaleAggregateError } from '../../../platform/unit-of-work/errors';
import type {
  BusinessActivityConflict,
  BusinessActivityRepository,
} from '../application/ports/business-activity.repository';
import type { BusinessActivityState, BusinessActivityStatus } from '../domain/business-activity';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

const UNIQUE_CODE = 'business_activities_market_id_code_key';
const UNIQUE_NAME = 'business_activity_names_name_lower_key';

type ActivityRow = Prisma.CatalogBusinessActivityGetPayload<{
  include: { names: true; categories: true };
}>;

/** The include every read of an activity uses: names by locale, links by category id. */
export const ACTIVITY_INCLUDE = {
  names: { orderBy: { locale: 'asc' } },
  categories: { orderBy: { categoryId: 'asc' } },
} as const satisfies Prisma.CatalogBusinessActivityInclude;

/** A stored activity row, with its names and links, as the state of the activity. */
export function activityStateOf(row: ActivityRow): BusinessActivityState {
  return {
    id: row.id as Id<'BusinessActivity'>,
    code: row.code,
    status: row.status as BusinessActivityStatus,
    description: row.description,
    names: row.names.map((entry) => ({ locale: entry.locale, name: entry.name })),
    categoryIds: row.categories.map((link) => link.categoryId as Id<'Category'>),
    createdBy: row.createdBy as Id<'Account'>,
    createdAt: toInstant(row.createdAt),
    updatedAt: toInstant(row.updatedAt),
    version: row.version,
  };
}

/**
 * {@link BusinessActivityRepository} on `catalog.business_activities`, `business_activity_names`
 * and `business_activity_categories`. Every statement runs through `PrismaService.tx(market)` and
 * carries the Market; names and links are replaced as a set inside the use case's unit.
 */
export class PrismaBusinessActivityRepository implements BusinessActivityRepository {
  constructor(private readonly prisma: PrismaService) {}

  async add(
    market: MarketContext,
    state: BusinessActivityState,
  ): Promise<BusinessActivityConflict | null> {
    const tx = this.prisma.tx(market);
    try {
      await tx.catalogBusinessActivity.create({
        data: {
          id: state.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          code: state.code,
          description: state.description,
          status: state.status,
          createdBy: state.createdBy,
          createdAt: toDate(state.createdAt),
          updatedAt: toDate(state.updatedAt),
          version: state.version,
        },
        select: { id: true },
      });
      await this.#writeSets(market, state);
    } catch (error) {
      const conflict = this.#conflictOf(error);
      if (conflict !== null) return conflict;
      throw error;
    }
    return null;
  }

  async findById(
    market: MarketContext,
    id: Id<'BusinessActivity'>,
  ): Promise<BusinessActivityState | null> {
    const row = await this.prisma.tx(market).catalogBusinessActivity.findFirst({
      where: { marketId: market.marketId, id },
      include: ACTIVITY_INCLUDE,
    });
    return row === null ? null : activityStateOf(row);
  }

  async codeTaken(market: MarketContext, code: string): Promise<boolean> {
    const row = await this.prisma.tx(market).catalogBusinessActivity.findFirst({
      where: { marketId: market.marketId, code },
      select: { id: true },
    });
    return row !== null;
  }

  async save(
    market: MarketContext,
    state: BusinessActivityState,
    expectedVersion: number,
  ): Promise<BusinessActivityConflict | null> {
    const tx = this.prisma.tx(market);
    try {
      const { count } = await tx.catalogBusinessActivity.updateMany({
        where: { marketId: market.marketId, id: state.id, version: expectedVersion },
        data: {
          description: state.description,
          status: state.status,
          updatedAt: toDate(state.updatedAt),
          version: state.version,
        },
      });
      if (count !== 1) throw new StaleAggregateError('business-activity', state.id);
      await tx.catalogBusinessActivityName.deleteMany({
        where: { marketId: market.marketId, activityId: state.id },
      });
      await tx.catalogBusinessActivityCategory.deleteMany({
        where: { marketId: market.marketId, activityId: state.id },
      });
      await this.#writeSets(market, state);
    } catch (error) {
      const conflict = this.#conflictOf(error);
      if (conflict !== null) return conflict;
      throw error;
    }
    return null;
  }

  async #writeSets(market: MarketContext, state: BusinessActivityState): Promise<void> {
    const tx = this.prisma.tx(market);
    if (state.names.length > 0) {
      await tx.catalogBusinessActivityName.createMany({
        data: state.names.map((entry) => ({
          marketId: market.marketId,
          tenantId: market.tenantId,
          activityId: state.id,
          locale: entry.locale,
          name: entry.name,
        })),
      });
    }
    if (state.categoryIds.length > 0) {
      await tx.catalogBusinessActivityCategory.createMany({
        data: state.categoryIds.map((categoryId) => ({
          marketId: market.marketId,
          tenantId: market.tenantId,
          activityId: state.id,
          categoryId,
          createdAt: toDate(state.updatedAt),
        })),
      });
    }
  }

  #conflictOf(error: unknown): BusinessActivityConflict | null {
    const violated = this.prisma.violatedConstraint(error);
    if (violated === UNIQUE_CODE) return 'business-activity.code-taken';
    if (violated === UNIQUE_NAME) return 'business-activity.name-taken';
    return null;
  }
}
