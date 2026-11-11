import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { StaleAggregateError } from '../../../platform/unit-of-work/errors';
import type { CultureConflict, CultureRepository } from '../application/ports/culture.repository';
import type { CultureState, CultureStatus } from '../domain/culture';
import type { CertificationMark, CultureCategoryRow } from '../domain/culture-category';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

const UNIQUE_CODE = 'cultures_market_id_code_key';
const UNIQUE_NAME = 'culture_names_name_lower_key';

type CultureRow = Prisma.CatalogCultureGetPayload<{ include: { names: true } }>;

/** The include every read of a culture uses: its names by locale. */
export const CULTURE_INCLUDE = {
  names: { orderBy: { locale: 'asc' } },
} as const satisfies Prisma.CatalogCultureInclude;

/** A stored culture row, with its names, as the state of the culture. */
export function cultureStateOf(row: CultureRow): CultureState {
  return {
    id: row.id as Id<'Culture'>,
    code: row.code,
    status: row.status as CultureStatus,
    displayOrder: row.displayOrder,
    requiredCertificationType: row.requiredCertificationType,
    badgeColour: row.badgeColour,
    isDefault: row.isDefault,
    names: row.names.map((entry) => ({
      locale: entry.locale,
      name: entry.name,
      description: entry.description,
    })),
    createdBy: row.createdBy as Id<'Account'>,
    createdAt: toInstant(row.createdAt),
    updatedAt: toInstant(row.updatedAt),
    version: row.version,
  };
}

/**
 * {@link CultureRepository} on `catalog.cultures`, `culture_names` and `culture_categories`. Every
 * statement runs through `PrismaService.tx(market)` and carries the Market; names are replaced as a
 * set inside the use case's unit.
 */
export class PrismaCultureRepository implements CultureRepository {
  constructor(private readonly prisma: PrismaService) {}

  async add(market: MarketContext, state: CultureState): Promise<CultureConflict | null> {
    const tx = this.prisma.tx(market);
    try {
      await tx.catalogCulture.create({
        data: {
          id: state.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          code: state.code,
          status: state.status,
          displayOrder: state.displayOrder,
          requiredCertificationType: state.requiredCertificationType,
          badgeColour: state.badgeColour,
          isDefault: state.isDefault,
          createdBy: state.createdBy,
          createdAt: toDate(state.createdAt),
          updatedAt: toDate(state.updatedAt),
          version: state.version,
        },
        select: { id: true },
      });
      await this.#writeNames(market, state);
    } catch (error) {
      const conflict = this.#conflictOf(error);
      if (conflict !== null) return conflict;
      throw error;
    }
    return null;
  }

  async findById(market: MarketContext, id: Id<'Culture'>): Promise<CultureState | null> {
    const row = await this.prisma.tx(market).catalogCulture.findFirst({
      where: { marketId: market.marketId, id },
      include: CULTURE_INCLUDE,
    });
    return row === null ? null : cultureStateOf(row);
  }

  async codeTaken(market: MarketContext, code: string): Promise<boolean> {
    const row = await this.prisma.tx(market).catalogCulture.findFirst({
      where: { marketId: market.marketId, code },
      select: { id: true },
    });
    return row !== null;
  }

  async defaultId(market: MarketContext): Promise<Id<'Culture'> | null> {
    const row = await this.prisma.tx(market).catalogCulture.findFirst({
      where: { marketId: market.marketId, isDefault: true },
      select: { id: true },
    });
    return row === null ? null : (row.id as Id<'Culture'>);
  }

  count(market: MarketContext): Promise<number> {
    return this.prisma.tx(market).catalogCulture.count({ where: { marketId: market.marketId } });
  }

  async save(
    market: MarketContext,
    state: CultureState,
    expectedVersion: number,
  ): Promise<CultureConflict | null> {
    const tx = this.prisma.tx(market);
    try {
      const { count } = await tx.catalogCulture.updateMany({
        where: { marketId: market.marketId, id: state.id, version: expectedVersion },
        data: {
          status: state.status,
          displayOrder: state.displayOrder,
          requiredCertificationType: state.requiredCertificationType,
          badgeColour: state.badgeColour,
          isDefault: state.isDefault,
          updatedAt: toDate(state.updatedAt),
          version: state.version,
        },
      });
      if (count !== 1) throw new StaleAggregateError('culture', state.id);
      await tx.catalogCultureName.deleteMany({
        where: { marketId: market.marketId, cultureId: state.id },
      });
      await this.#writeNames(market, state);
    } catch (error) {
      const conflict = this.#conflictOf(error);
      if (conflict !== null) return conflict;
      throw error;
    }
    return null;
  }

  async clearDefaultExcept(
    market: MarketContext,
    exceptId: Id<'Culture'>,
    now: Temporal.Instant,
  ): Promise<void> {
    await this.prisma.tx(market).catalogCulture.updateMany({
      where: { marketId: market.marketId, isDefault: true, id: { not: exceptId } },
      data: { isDefault: false, updatedAt: toDate(now), version: { increment: 1 } },
    });
  }

  async categoryRows(
    market: MarketContext,
    cultureId: Id<'Culture'>,
  ): Promise<readonly CultureCategoryRow[]> {
    const rows = await this.prisma.tx(market).catalogCultureCategory.findMany({
      where: { marketId: market.marketId, cultureId },
      orderBy: { categoryId: 'asc' },
    });
    return rows.map((row) => ({
      categoryId: row.categoryId as Id<'Category'>,
      visible: row.visible,
      certificationMark: row.certificationMark as CertificationMark | null,
    }));
  }

  async setCategoryRow(
    market: MarketContext,
    cultureId: Id<'Culture'>,
    row: CultureCategoryRow,
    updatedBy: Id<'Account'>,
    now: Temporal.Instant,
  ): Promise<void> {
    const tx = this.prisma.tx(market);
    const { count } = await tx.catalogCultureCategory.updateMany({
      where: { marketId: market.marketId, cultureId, categoryId: row.categoryId },
      data: {
        visible: row.visible,
        certificationMark: row.certificationMark,
        updatedBy,
        updatedAt: toDate(now),
      },
    });
    if (count === 1) return;
    await tx.catalogCultureCategory.create({
      data: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        cultureId,
        categoryId: row.categoryId,
        visible: row.visible,
        certificationMark: row.certificationMark,
        updatedBy,
        updatedAt: toDate(now),
      },
    });
  }

  async clearCategoryRow(
    market: MarketContext,
    cultureId: Id<'Culture'>,
    categoryId: Id<'Category'>,
  ): Promise<boolean> {
    const { count } = await this.prisma.tx(market).catalogCultureCategory.deleteMany({
      where: { marketId: market.marketId, cultureId, categoryId },
    });
    return count === 1;
  }

  async #writeNames(market: MarketContext, state: CultureState): Promise<void> {
    if (state.names.length === 0) return;
    await this.prisma.tx(market).catalogCultureName.createMany({
      data: state.names.map((entry) => ({
        marketId: market.marketId,
        tenantId: market.tenantId,
        cultureId: state.id,
        locale: entry.locale,
        name: entry.name,
        description: entry.description,
      })),
    });
  }

  #conflictOf(error: unknown): CultureConflict | null {
    const violated = this.prisma.violatedConstraint(error);
    if (violated === UNIQUE_CODE) return 'culture.code-taken';
    if (violated === UNIQUE_NAME) return 'culture.name-taken';
    return null;
  }
}
