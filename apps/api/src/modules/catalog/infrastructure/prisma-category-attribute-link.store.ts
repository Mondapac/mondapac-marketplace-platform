import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, MarketId } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { StaleAggregateError } from '../../../platform/unit-of-work/errors';
import type {
  CategoryAttributeLinkStore,
  StoredLinkFact,
} from '../application/ports/category-attribute-link.store';
import {
  CategoryAttributeLink,
  type CategoryAttributeLinkState,
} from '../domain/category-attribute-link';
import type { CategoryStatus } from '../domain/platform-category';

const toDate = (instant: { readonly epochMilliseconds: number }): Date =>
  new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

const filtersOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((code): code is string => typeof code === 'string') : [];

/**
 * {@link CategoryAttributeLinkStore} on `catalog.category_attribute_links` and their insert-only
 * revisions (attributes A4). Every statement goes through `PrismaService.tx(market)` with
 * `marketId` at the top level of `where`; the root row is written only in its granted columns.
 */
export class PrismaCategoryAttributeLinkStore implements CategoryAttributeLinkStore {
  constructor(private readonly prisma: PrismaService) {}

  async find(
    market: MarketContext,
    categoryId: Id<'Category'>,
  ): Promise<CategoryAttributeLink | null> {
    const row = await this.prisma.tx(market).catalogCategoryAttributeLink.findFirst({
      where: { marketId: market.marketId, categoryId },
      include: { publishedRevision: true },
    });
    const revision = row?.publishedRevision;
    if (row === null || revision === null || revision === undefined) return null;
    const state: CategoryAttributeLinkState = {
      marketId: row.marketId as MarketId,
      categoryId: row.categoryId as Id<'Category'>,
      familyId: revision.familyId as Id<'AttributeFamily'> | null,
      filters: filtersOf(revision.filters),
      revisionId: revision.id as Id<'CategoryAttributeLinkRevision'>,
      revisionNo: revision.revisionNo,
      version: row.version,
      createdAt: toInstant(row.createdAt),
      revisedAt: toInstant(revision.createdAt),
    };
    return CategoryAttributeLink.rehydrate(state);
  }

  async all(market: MarketContext, limit: number): Promise<readonly StoredLinkFact[]> {
    const tx = this.prisma.tx(market);
    const roots = await tx.catalogCategoryAttributeLink.findMany({
      where: { marketId: market.marketId, publishedRevisionId: { not: null } },
      select: { categoryId: true, publishedRevisionId: true },
      orderBy: { categoryId: 'asc' },
      take: limit,
    });
    if (roots.length === 0) return [];
    const revisions = await tx.catalogCategoryAttributeLinkRevision.findMany({
      where: {
        marketId: market.marketId,
        id: { in: roots.map((root) => root.publishedRevisionId as string) },
      },
      select: { id: true, categoryId: true, familyId: true, filters: true },
    });
    return revisions.map((revision) => ({
      categoryId: revision.categoryId as Id<'Category'>,
      familyId: revision.familyId as Id<'AttributeFamily'> | null,
      filters: filtersOf(revision.filters),
    }));
  }

  async categoryStatus(
    market: MarketContext,
    categoryId: Id<'Category'>,
  ): Promise<CategoryStatus | null> {
    const row = await this.prisma.tx(market).catalogPlatformCategory.findFirst({
      where: { marketId: market.marketId, id: categoryId },
      select: { status: true },
    });
    return row === null ? null : (row.status as CategoryStatus);
  }

  async add(
    market: MarketContext,
    link: CategoryAttributeLink,
    authorAccountId: Id<'Account'>,
  ): Promise<void> {
    const state = link.state;
    this.#sameMarket(market, state);
    if (state.version !== 1 || state.revisionNo !== 1) {
      throw new Error('add: only a first link is added');
    }
    const tx = this.prisma.tx(market);
    try {
      await tx.catalogCategoryAttributeLink.create({
        data: {
          marketId: market.marketId,
          tenantId: market.tenantId,
          categoryId: state.categoryId,
          publishedRevisionId: null,
          version: state.version,
          createdAt: toDate(state.createdAt),
        },
        select: { categoryId: true },
      });
    } catch (error) {
      // A racing first link for the same category fails on the primary key.
      if (isUniqueViolation(error))
        throw new StaleAggregateError('category-links', state.categoryId);
      throw error;
    }
    await this.#insertRevision(market, state, authorAccountId);
    const { count } = await tx.catalogCategoryAttributeLink.updateMany({
      where: { marketId: market.marketId, categoryId: state.categoryId, version: state.version },
      data: { publishedRevisionId: state.revisionId },
    });
    if (count !== 1) throw new StaleAggregateError('category-links', state.categoryId);
  }

  async saveRevision(
    market: MarketContext,
    link: CategoryAttributeLink,
    authorAccountId: Id<'Account'>,
  ): Promise<void> {
    const state = link.state;
    this.#sameMarket(market, state);
    await this.#insertRevision(market, state, authorAccountId);
    const { count } = await this.prisma.tx(market).catalogCategoryAttributeLink.updateMany({
      where: {
        marketId: market.marketId,
        categoryId: state.categoryId,
        version: state.version - 1,
      },
      data: { publishedRevisionId: state.revisionId, version: state.version },
    });
    if (count !== 1) throw new StaleAggregateError('category-links', state.categoryId);
  }

  async #insertRevision(
    market: MarketContext,
    state: CategoryAttributeLinkState,
    authorAccountId: Id<'Account'>,
  ): Promise<void> {
    try {
      await this.prisma.tx(market).catalogCategoryAttributeLinkRevision.create({
        data: {
          id: state.revisionId,
          marketId: market.marketId,
          tenantId: market.tenantId,
          categoryId: state.categoryId,
          revisionNo: state.revisionNo,
          familyId: state.familyId,
          filters: [...state.filters],
          authorAccountId,
          createdAt: toDate(state.revisedAt),
        },
        select: { id: true },
      });
    } catch (error) {
      if (isUniqueViolation(error))
        throw new StaleAggregateError('category-links', state.categoryId);
      throw error;
    }
  }

  #sameMarket(market: MarketContext, state: CategoryAttributeLinkState): void {
    if (state.marketId !== market.marketId) {
      throw new Error('PrismaCategoryAttributeLinkStore: the link is of another Market');
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  );
}
