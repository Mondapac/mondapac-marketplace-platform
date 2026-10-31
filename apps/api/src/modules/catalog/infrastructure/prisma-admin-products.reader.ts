import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  AdminProductRow,
  AdminProductSort,
  AdminProductsFilter,
  AdminProductsPageResult,
  AdminProductsReader,
  SortDirection,
} from '../application/ports/admin-products.reader';
import type { ProductScope, ProductStatus } from '../domain/product';

const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

/** Sorting by name holds the matching products in memory; more than this must be narrowed. */
export const NAME_SORT_LIMIT = 5000;

/** Escapes `\`, `%` and `_`, so a search term is matched as typed (LIKE patterns). */
const literal = (term: string): string => term.replace(/[\\%_]/g, (char) => `\\${char}`);

/**
 * A condition on the revision a row shows: the published one, else (never published) the pending
 * one. The same revision gives the name, the photo and the category of the row.
 */
const viaShownRevision = (
  condition: Prisma.CatalogProductRevisionWhereInput,
): Prisma.CatalogProductWhereInput => ({
  OR: [
    { publishedRevision: { is: condition } },
    { publishedRevisionId: null, pendingRevision: { is: condition } },
  ],
});

function whereOf(
  market: MarketContext,
  filter: AdminProductsFilter,
): Prisma.CatalogProductWhereInput {
  const and: Prisma.CatalogProductWhereInput[] = [];
  if (filter.categoryId !== null) {
    and.push(viaShownRevision({ categories: { some: { categoryId: filter.categoryId } } }));
  }
  if (filter.text !== null) {
    const part = literal(filter.text);
    and.push({
      OR: [
        { productCode: { contains: part, mode: 'insensitive' } },
        viaShownRevision({
          texts: { some: { locale: filter.locale, name: { contains: part, mode: 'insensitive' } } },
        }),
      ],
    });
  }
  return {
    marketId: market.marketId,
    status: { in: [...filter.statuses] },
    ...(filter.scope === null ? {} : { scope: filter.scope }),
    ...(filter.typeCode === null ? {} : { typeCode: filter.typeCode }),
    ...(filter.sellerId === null ? {} : { ownerSellerId: filter.sellerId }),
    ...(and.length === 0 ? {} : { AND: and }),
  };
}

interface Picked {
  readonly id: string;
  readonly shownRevisionId: string | null;
}

/**
 * {@link AdminProductsReader} on `catalog.products`, the revisions, `offers` and the category
 * names. Every statement goes through `PrismaService.tx(market)` with `marketId` in `where`.
 * Ordering is in the database, except by name: the name lives in a revision text per locale, so
 * that order is made in memory over the matching products (at most {@link NAME_SORT_LIMIT}).
 */
export class PrismaAdminProductsReader implements AdminProductsReader {
  constructor(private readonly prisma: PrismaService) {}

  async counts(
    market: MarketContext,
    filters: readonly AdminProductsFilter[],
  ): Promise<readonly number[]> {
    const tx = this.prisma.tx(market);
    const counts: number[] = [];
    for (const filter of filters) {
      counts.push(await tx.catalogProduct.count({ where: whereOf(market, filter) }));
    }
    return counts;
  }

  async list(
    market: MarketContext,
    filter: AdminProductsFilter,
    order: { readonly sort: AdminProductSort; readonly direction: SortDirection },
    page: { readonly offset: number; readonly limit: number },
  ): Promise<AdminProductsPageResult> {
    const tx = this.prisma.tx(market);
    const where = whereOf(market, filter);
    const { direction } = order;
    let picked: Picked[];
    if (order.sort === 'name') {
      const candidates = await tx.catalogProduct.findMany({
        where,
        select: { id: true, publishedRevisionId: true, pendingRevisionId: true },
        orderBy: { id: 'asc' },
        take: NAME_SORT_LIMIT + 1,
      });
      if (candidates.length > NAME_SORT_LIMIT) return { kind: 'too-broad' };
      const shown = candidates.map((row) => ({
        id: row.id,
        shownRevisionId: row.publishedRevisionId ?? row.pendingRevisionId,
      }));
      const names = await this.namesOf(
        market,
        shown.flatMap((row) => (row.shownRevisionId === null ? [] : [row.shownRevisionId])),
        filter.locale,
      );
      const collator = new Intl.Collator(filter.locale, { sensitivity: 'base', numeric: true });
      const sign = direction === 'asc' ? 1 : -1;
      const nameOf = (row: Picked): string | null =>
        row.shownRevisionId === null ? null : (names.get(row.shownRevisionId) ?? null);
      shown.sort((a, b) => {
        const left = nameOf(a);
        const right = nameOf(b);
        // A product without a name in the locale sorts last in either direction.
        if (left === null || right === null) {
          if (left === right) return a.id < b.id ? -1 : 1;
          return left === null ? 1 : -1;
        }
        return sign * collator.compare(left, right) || (a.id < b.id ? -1 : 1);
      });
      picked = shown.slice(page.offset, page.offset + page.limit);
    } else {
      const column = order.sort === 'created' ? 'createdAt' : 'lastChangedAt';
      const rows = await tx.catalogProduct.findMany({
        where,
        select: { id: true, publishedRevisionId: true, pendingRevisionId: true },
        orderBy: [{ [column]: direction }, { id: direction }],
        skip: page.offset,
        take: page.limit,
      });
      picked = rows.map((row) => ({
        id: row.id,
        shownRevisionId: row.publishedRevisionId ?? row.pendingRevisionId,
      }));
    }
    return { kind: 'rows', rows: await this.rowsOf(market, picked, filter.locale) };
  }

  private async namesOf(
    market: MarketContext,
    revisionIds: readonly string[],
    locale: string,
  ): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    const tx = this.prisma.tx(market);
    // Chunks keep each statement's parameter list short.
    for (let start = 0; start < revisionIds.length; start += 1000) {
      const texts = await tx.catalogProductRevisionText.findMany({
        where: {
          marketId: market.marketId,
          locale,
          revisionId: { in: revisionIds.slice(start, start + 1000) },
        },
        select: { revisionId: true, name: true },
      });
      for (const text of texts) names.set(text.revisionId, text.name);
    }
    return names;
  }

  /** The rows of one page, in the order of `picked`. */
  private async rowsOf(
    market: MarketContext,
    picked: readonly Picked[],
    locale: string,
  ): Promise<readonly AdminProductRow[]> {
    if (picked.length === 0) return [];
    const tx = this.prisma.tx(market);
    const products = await tx.catalogProduct.findMany({
      where: { marketId: market.marketId, id: { in: picked.map((row) => row.id) } },
    });
    const byId = new Map(products.map((row) => [row.id, row]));
    const revisionIds = picked.flatMap((row) =>
      row.shownRevisionId === null ? [] : [row.shownRevisionId],
    );
    const revisions =
      revisionIds.length === 0
        ? []
        : await tx.catalogProductRevision.findMany({
            where: { marketId: market.marketId, id: { in: revisionIds } },
            select: {
              id: true,
              texts: { where: { locale }, select: { name: true } },
              categories: { orderBy: { position: 'asc' }, take: 1, select: { categoryId: true } },
              images: {
                where: { image: { state: 'clean' } },
                orderBy: { position: 'asc' },
                take: 1,
                select: { imageId: true },
              },
            },
          });
    const revisionById = new Map(revisions.map((row) => [row.id, row]));
    const categoryIds = [
      ...new Set(revisions.flatMap((row) => row.categories.map((entry) => entry.categoryId))),
    ];
    const categories =
      categoryIds.length === 0
        ? []
        : await tx.catalogPlatformCategory.findMany({
            where: { marketId: market.marketId, id: { in: categoryIds } },
            select: {
              id: true,
              publishedRevision: {
                select: { names: { where: { locale }, select: { name: true } } },
              },
            },
          });
    const categoryName = new Map(
      categories.map((row) => [row.id, row.publishedRevision?.names[0]?.name ?? null]),
    );
    const offerCounts = await tx.catalogOffer.groupBy({
      by: ['productId'],
      where: {
        marketId: market.marketId,
        productId: { in: picked.map((row) => row.id) },
        status: { not: 'deleted' },
      },
      _count: { _all: true },
    });
    const offersOf = new Map(offerCounts.map((row) => [row.productId, row._count._all]));
    return picked.flatMap((entry): AdminProductRow[] => {
      const row = byId.get(entry.id);
      if (row === undefined) return [];
      const revision =
        entry.shownRevisionId === null ? undefined : revisionById.get(entry.shownRevisionId);
      const categoryId = revision?.categories[0]?.categoryId ?? null;
      return [
        {
          productId: row.id as Id<'Product'>,
          productCode: row.productCode,
          name: revision?.texts[0]?.name ?? null,
          primaryImageId: (revision?.images[0]?.imageId ?? null) as Id<'ProductImage'> | null,
          scope: row.scope as ProductScope,
          ownerSellerId: row.ownerSellerId as Id<'Seller'> | null,
          categoryId: categoryId as Id<'Category'> | null,
          categoryName: categoryId === null ? null : (categoryName.get(categoryId) ?? null),
          typeCode: row.typeCode,
          status: row.status as ProductStatus,
          offerCount: offersOf.get(row.id) ?? 0,
          updatedAt: toInstant(row.lastChangedAt),
          createdAt: toInstant(row.createdAt),
        },
      ];
    });
  }
}
