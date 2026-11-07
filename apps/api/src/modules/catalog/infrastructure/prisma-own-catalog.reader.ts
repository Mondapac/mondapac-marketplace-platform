import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, MeasureSettings } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { Prisma } from '../../../generated/prisma/client';
import type {
  ListPage,
  OwnCatalogReader,
  OwnProductRow,
  OwnProductSort,
  OwnProductsFilter,
  OwnProductsPageResult,
  OwnSortDirection,
  PendingRevisionRow,
  ProductForm,
  ProductFormField,
  ProductLabel,
  RevisionQueueFilter,
} from '../application/ports/own-catalog.reader';
import type { FamilyGroup } from '../domain/attribute-family';
import type { Offer } from '../domain/offer';
import type { Product, ProductStatus } from '../domain/product';
import type { WorkingCopy } from '../domain/working-copy';
import { offerFromRow } from './prisma-offer.repository';
import { productFromRow } from './prisma-product.repository';

const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

/** Hard ceiling on a page, whatever the caller asks. */
const MAX_PAGE = 100;

/** Sorting by name holds the matching products in memory; more than this must be narrowed. */
export const OWN_NAME_SORT_LIMIT = 2000;

/** Escapes `\\`, `%` and `_`, so a search term is matched as typed (LIKE patterns). */
const literal = (term: string): string => term.replace(/[\\%_]/g, (char) => `\\${char}`);

/**
 * A condition on the revision a row shows: the published one, else (never published) the pending
 * one.
 */
const viaShownRevision = (
  condition: Prisma.CatalogProductRevisionWhereInput,
): Prisma.CatalogProductWhereInput => ({
  OR: [
    { publishedRevision: { is: condition } },
    { publishedRevisionId: null, pendingRevision: { is: condition } },
  ],
});

/** The seller's list filter. A name, a category or a photo comes from the draft, else the shown revision. */
function listWhere(
  market: MarketContext,
  sellerId: Id<'Seller'>,
  filter: OwnProductsFilter,
): Prisma.CatalogProductWhereInput {
  const and: Prisma.CatalogProductWhereInput[] = [];
  if (filter.categoryId !== null) {
    and.push({
      OR: [
        {
          workingCopy: {
            is: { content: { path: ['categoryIds'], array_contains: [filter.categoryId] } },
          },
        },
        viaShownRevision({ categories: { some: { categoryId: filter.categoryId } } }),
      ],
    });
  }
  if (filter.text !== null) {
    const part = literal(filter.text);
    and.push({
      OR: [
        { productCode: { contains: part, mode: 'insensitive' } },
        {
          workingCopy: {
            is: {
              content: {
                path: ['texts', filter.locale, 'name'],
                string_contains: part,
                mode: 'insensitive',
              },
            },
          },
        },
        viaShownRevision({
          texts: { some: { locale: filter.locale, name: { contains: part, mode: 'insensitive' } } },
        }),
      ],
    });
  }
  return {
    marketId: market.marketId,
    scope: 'SELLER',
    ownerSellerId: sellerId,
    status: { in: [...filter.statuses] },
    ...(filter.inReview ? { pendingRevisionId: { not: null } } : {}),
    ...(filter.paused === null ? {} : { pausedAt: filter.paused ? { not: null } : null }),
    ...(filter.typeCode === null ? {} : { typeCode: filter.typeCode }),
    ...(and.length === 0 ? {} : { AND: and }),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The draft's name in a locale, read defensively: a draft is only shape-checked at save. */
function draftNameIn(content: unknown, locale: string): string | null {
  if (!isRecord(content) || !isRecord(content['texts'])) return null;
  const entry = content['texts'][locale];
  const name = isRecord(entry) ? entry['name'] : undefined;
  return typeof name === 'string' && name !== '' ? name : null;
}

function draftIds(content: unknown, key: 'categoryIds' | 'imageIds'): readonly string[] {
  if (!isRecord(content)) return [];
  const list = content[key];
  return Array.isArray(list)
    ? list.filter((item): item is string => typeof item === 'string').slice(0, 20)
    : [];
}

interface Candidate {
  readonly id: string;
  readonly shownRevisionId: string | null;
  readonly content: unknown;
}

/**
 * The SELLER products of the Market with a pending revision that `filter` keeps: one seller (the
 * owner), a first publication (never published) or an update, a pending revision with or without a
 * photo. The `pendingRevision` relation is the product's own pointer (same product, same Market).
 */
function pendingRevisionsWhere(market: MarketContext, filter: RevisionQueueFilter) {
  return {
    marketId: market.marketId,
    scope: 'SELLER',
    pendingRevisionId: { not: null },
    ...(filter.sellerId === undefined ? {} : { ownerSellerId: filter.sellerId }),
    ...(filter.firstPublication === undefined
      ? {}
      : { publishedRevisionId: filter.firstPublication ? null : { not: null } }),
    ...(filter.hasImages === undefined
      ? {}
      : { pendingRevision: { images: filter.hasImages ? { some: {} } : { none: {} } } }),
  } satisfies Prisma.CatalogProductWhereInput;
}

/**
 * {@link OwnCatalogReader} on `catalog.products`, `offers` and `product_working_copies`. Every
 * statement goes through `PrismaService.tx(market)` with `marketId` and the owning seller in
 * `where`; ordering by the UUID v7 id is time order and needs no extra column.
 */
export class PrismaOwnCatalogReader implements OwnCatalogReader {
  constructor(private readonly prisma: PrismaService) {}

  async listProducts(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    page: ListPage<'Product'>,
  ): Promise<readonly Product[]> {
    const rows = await this.prisma.tx(market).catalogProduct.findMany({
      where: {
        marketId: market.marketId,
        scope: 'SELLER',
        ownerSellerId: sellerId,
        status: { notIn: ['discarded', 'withdrawn'] },
        ...(page.afterId === null ? {} : { id: { lt: page.afterId } }),
      },
      include: { variants: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
      orderBy: { id: 'desc' },
      take: Math.min(page.limit, MAX_PAGE),
    });
    return rows.map(productFromRow);
  }

  async countProductsBy(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    filters: readonly OwnProductsFilter[],
  ): Promise<readonly number[]> {
    const tx = this.prisma.tx(market);
    const counts: number[] = [];
    for (const filter of filters) {
      counts.push(await tx.catalogProduct.count({ where: listWhere(market, sellerId, filter) }));
    }
    return counts;
  }

  async listProductPage(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    filter: OwnProductsFilter,
    order: { readonly sort: OwnProductSort; readonly direction: OwnSortDirection },
    page: { readonly offset: number; readonly limit: number },
  ): Promise<OwnProductsPageResult> {
    const tx = this.prisma.tx(market);
    const where = listWhere(market, sellerId, filter);
    const select = {
      id: true,
      publishedRevisionId: true,
      pendingRevisionId: true,
      workingCopy: { select: { content: true } },
    } satisfies Prisma.CatalogProductSelect;
    const candidateOf = (row: {
      id: string;
      publishedRevisionId: string | null;
      pendingRevisionId: string | null;
      workingCopy: { content: unknown } | null;
    }): Candidate => ({
      id: row.id,
      shownRevisionId: row.publishedRevisionId ?? row.pendingRevisionId,
      content: row.workingCopy?.content ?? null,
    });
    let picked: Candidate[];
    if (order.sort === 'name') {
      const found = await tx.catalogProduct.findMany({
        where,
        select,
        orderBy: { id: 'asc' },
        take: OWN_NAME_SORT_LIMIT + 1,
      });
      if (found.length > OWN_NAME_SORT_LIMIT) return { kind: 'too-broad' };
      const candidates = found.map(candidateOf);
      const names = await this.revisionNames(
        market,
        candidates.flatMap((row) =>
          row.shownRevisionId === null || draftNameIn(row.content, filter.locale) !== null
            ? []
            : [row.shownRevisionId],
        ),
        filter.locale,
      );
      const nameOf = (row: Candidate): string | null =>
        draftNameIn(row.content, filter.locale) ??
        (row.shownRevisionId === null ? null : (names.get(row.shownRevisionId) ?? null));
      const collator = new Intl.Collator(filter.locale, { sensitivity: 'base', numeric: true });
      const sign = order.direction === 'asc' ? 1 : -1;
      candidates.sort((a, b) => {
        const left = nameOf(a);
        const right = nameOf(b);
        // A product without a name in the locale sorts last in either direction.
        if (left === null || right === null) {
          if (left === right) return a.id < b.id ? -1 : 1;
          return left === null ? 1 : -1;
        }
        return sign * collator.compare(left, right) || (a.id < b.id ? -1 : 1);
      });
      picked = candidates.slice(page.offset, page.offset + page.limit);
    } else {
      const column = order.sort === 'created' ? 'createdAt' : 'lastChangedAt';
      const rows = await tx.catalogProduct.findMany({
        where,
        select,
        orderBy: [{ [column]: order.direction }, { id: order.direction }],
        skip: page.offset,
        take: page.limit,
      });
      picked = rows.map(candidateOf);
    }
    return { kind: 'rows', rows: await this.productRows(market, sellerId, picked, filter.locale) };
  }

  private async revisionNames(
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

  /** The rows of one page (at most 100), in the order of `picked`. */
  private async productRows(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    picked: readonly Candidate[],
    locale: string,
  ): Promise<readonly OwnProductRow[]> {
    if (picked.length === 0) return [];
    const tx = this.prisma.tx(market);
    const productIds = picked.map((row) => row.id).slice(0, MAX_PAGE);
    const products = await tx.catalogProduct.findMany({
      where: {
        marketId: market.marketId,
        scope: 'SELLER',
        ownerSellerId: sellerId,
        id: { in: productIds },
      },
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
    // The draft's photos count only while they are not taken down.
    const draftImageIds = picked.flatMap((row) => draftIds(row.content, 'imageIds'));
    const cleanImages =
      draftImageIds.length === 0
        ? []
        : await tx.catalogProductImage.findMany({
            where: {
              marketId: market.marketId,
              productId: { in: productIds },
              id: { in: draftImageIds },
              state: 'clean',
            },
            select: { id: true, productId: true },
          });
    const cleanOf = new Set(cleanImages.map((row) => `${row.productId}/${row.id}`));
    const categoryOf = (entry: Candidate): string | null =>
      draftIds(entry.content, 'categoryIds')[0] ??
      (entry.shownRevisionId === null
        ? null
        : (revisionById.get(entry.shownRevisionId)?.categories[0]?.categoryId ?? null));
    const categoryIds = [...new Set(picked.flatMap((entry) => categoryOf(entry) ?? []))];
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
        sellerId,
        productId: { in: productIds },
        status: { not: 'deleted' },
      },
      _count: { _all: true },
    });
    const offersOf = new Map(offerCounts.map((row) => [row.productId, row._count._all]));
    return picked.flatMap((entry): OwnProductRow[] => {
      const row = byId.get(entry.id);
      if (row === undefined) return [];
      const revision =
        entry.shownRevisionId === null ? undefined : revisionById.get(entry.shownRevisionId);
      const draftName = draftNameIn(entry.content, locale);
      const draftImage = draftIds(entry.content, 'imageIds').find((imageId) =>
        cleanOf.has(`${row.id}/${imageId}`),
      );
      const categoryId = categoryOf(entry);
      return [
        {
          productId: row.id as Id<'Product'>,
          productCode: row.productCode,
          typeCode: row.typeCode,
          status: row.status as ProductStatus,
          name: draftName ?? revision?.texts[0]?.name ?? null,
          draftName,
          primaryImageId: (draftImage ??
            revision?.images[0]?.imageId ??
            null) as Id<'ProductImage'> | null,
          categoryId: categoryId as Id<'Category'> | null,
          categoryName: categoryId === null ? null : (categoryName.get(categoryId) ?? null),
          offerCount: offersOf.get(row.id) ?? 0,
          pausedAt: row.pausedAt === null ? null : toInstant(row.pausedAt),
          hasPublishedRevision: row.publishedRevisionId !== null,
          hasPendingRevision: row.pendingRevisionId !== null,
          pendingSubmittedAt:
            row.pendingSubmittedAt === null ? null : toInstant(row.pendingSubmittedAt),
          lastChangedAt: toInstant(row.lastChangedAt),
          createdAt: toInstant(row.createdAt),
        },
      ];
    });
  }

  async listOffers(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    page: ListPage<'Offer'>,
  ): Promise<readonly Offer[]> {
    const rows = await this.prisma.tx(market).catalogOffer.findMany({
      where: {
        marketId: market.marketId,
        sellerId,
        status: { not: 'deleted' },
        ...(page.afterId === null ? {} : { id: { lt: page.afterId } }),
      },
      orderBy: { id: 'desc' },
      take: Math.min(page.limit, MAX_PAGE),
    });
    // Read-only projections for the list (no tags): never saved (I1).
    return rows.map((row) => offerFromRow(row));
  }

  async offerStatusCounts(market: MarketContext, sellerId: Id<'Seller'>) {
    const groups = await this.prisma.tx(market).catalogOffer.groupBy({
      by: ['status'],
      where: { marketId: market.marketId, sellerId, status: { not: 'deleted' } },
      _count: { _all: true },
    });
    const count = (status: string) =>
      groups.find((group) => group.status === status)?._count._all ?? 0;
    return {
      draft: count('draft'),
      pendingFirstPublish: count('pending-first-publish'),
      changesNeeded: count('changes-needed'),
      published: count('published'),
    };
  }

  async pendingReviewCount(
    market: MarketContext,
    filter: { readonly sellerId?: Id<'Seller'> } = {},
  ): Promise<number> {
    return this.prisma.tx(market).catalogOffer.count({
      where: {
        marketId: market.marketId,
        status: 'pending-first-publish',
        ...(filter.sellerId === undefined ? {} : { sellerId: filter.sellerId }),
      },
    });
  }

  async pendingRevisionCount(
    market: MarketContext,
    filter: RevisionQueueFilter = {},
  ): Promise<number> {
    return this.prisma.tx(market).catalogProduct.count({
      where: pendingRevisionsWhere(market, filter),
    });
  }

  async listPendingRevisions(
    market: MarketContext,
    page: {
      readonly after: { readonly submittedAt: Temporal.Instant; readonly id: string } | null;
      readonly limit: number;
    },
    locale: string,
    filter: RevisionQueueFilter = {},
  ): Promise<readonly PendingRevisionRow[]> {
    const tx = this.prisma.tx(market);
    const cursor = page.after;
    const after =
      cursor === null
        ? {}
        : {
            OR: [
              { pendingSubmittedAt: { gt: new Date(cursor.submittedAt.epochMilliseconds) } },
              {
                pendingSubmittedAt: new Date(cursor.submittedAt.epochMilliseconds),
                id: { gt: cursor.id },
              },
            ],
          };
    const products = await tx.catalogProduct.findMany({
      where: { ...pendingRevisionsWhere(market, filter), ...after },
      orderBy: [{ pendingSubmittedAt: 'asc' }, { id: 'asc' }],
      take: Math.min(page.limit, MAX_PAGE),
    });
    const revisionIds = products.flatMap((row) =>
      row.pendingRevisionId === null ? [] : [row.pendingRevisionId],
    );
    if (revisionIds.length === 0) return [];
    const revisions = await tx.catalogProductRevision.findMany({
      where: { marketId: market.marketId, id: { in: revisionIds } },
      select: {
        id: true,
        revisionNo: true,
        sensitiveReasons: true,
        texts: { where: { locale }, select: { name: true } },
        images: { select: { imageId: true }, take: 1 },
        variants: { where: { gtin: { not: null } }, select: { gtin: true } },
      },
    });
    const byId = new Map(revisions.map((row) => [row.id, row]));
    return products.flatMap((row) => {
      const revision = row.pendingRevisionId === null ? undefined : byId.get(row.pendingRevisionId);
      if (
        revision === undefined ||
        row.ownerSellerId === null ||
        row.pendingSubmittedAt === null ||
        row.pendingRevisionId === null
      ) {
        return [];
      }
      return [
        {
          productId: row.id as Id<'Product'>,
          productVersion: row.version,
          sellerId: row.ownerSellerId as Id<'Seller'>,
          productCode: row.productCode,
          typeCode: row.typeCode,
          revisionId: row.pendingRevisionId as Id<'ProductRevision'>,
          revisionNo: revision.revisionNo,
          firstPublication: row.publishedRevisionId === null,
          sensitiveReasons: revision.sensitiveReasons,
          hasImages: revision.images.length > 0,
          variantGtins: revision.variants.flatMap((variant) =>
            variant.gtin === null ? [] : [variant.gtin],
          ),
          name: revision.texts[0]?.name ?? null,
          submittedAt: toInstant(row.pendingSubmittedAt),
        },
      ];
    });
  }

  async productLabels(
    market: MarketContext,
    productIds: readonly Id<'Product'>[],
    locale: string,
  ): Promise<readonly ProductLabel[]> {
    if (productIds.length === 0) return [];
    const tx = this.prisma.tx(market);
    const products = await tx.catalogProduct.findMany({
      where: { marketId: market.marketId, id: { in: [...productIds].slice(0, MAX_PAGE) } },
      select: { id: true, productCode: true, typeCode: true, publishedRevisionId: true },
    });
    const revisionIds = products.flatMap((row) =>
      row.publishedRevisionId === null ? [] : [row.publishedRevisionId],
    );
    const texts =
      revisionIds.length === 0
        ? []
        : await tx.catalogProductRevisionText.findMany({
            where: { marketId: market.marketId, revisionId: { in: revisionIds }, locale },
            select: { revisionId: true, name: true },
          });
    const nameOf = new Map(texts.map((row) => [row.revisionId, row.name]));
    return products.map((row) => ({
      productId: row.id as Id<'Product'>,
      productCode: row.productCode,
      typeCode: row.typeCode,
      name: row.publishedRevisionId === null ? null : (nameOf.get(row.publishedRevisionId) ?? null),
    }));
  }

  async findWorkingCopies(
    market: MarketContext,
    productIds: readonly Id<'Product'>[],
  ): Promise<readonly WorkingCopy[]> {
    if (productIds.length === 0) return [];
    const rows = await this.prisma.tx(market).catalogProductWorkingCopy.findMany({
      where: { marketId: market.marketId, productId: { in: [...productIds].slice(0, MAX_PAGE) } },
    });
    return rows.map((row) => ({
      productId: row.productId as Id<'Product'>,
      content: row.content as Record<string, unknown>,
      contentSchemaVersion: row.contentSchemaVersion,
      baseRevisionId: row.baseRevisionId as Id<'ProductRevision'> | null,
      lastSavedAt: toInstant(row.lastSavedAt),
      lastSavedByAccountId: row.lastSavedByAccountId as Id<'Account'>,
    }));
  }

  async productForm(market: MarketContext, familyCode: string): Promise<ProductForm> {
    const tx = this.prisma.tx(market);
    const family = await tx.catalogAttributeFamily.findFirst({
      where: { marketId: market.marketId, code: familyCode, status: 'active' },
      include: { publishedRevision: true },
    });
    const groups = (family?.publishedRevision?.groups ?? []) as unknown as FamilyGroup[];
    const entries = groups.flatMap((group) => group.attributes);
    const rows =
      entries.length === 0
        ? []
        : await tx.catalogAttributeDefinition.findMany({
            where: {
              marketId: market.marketId,
              status: 'active',
              code: { in: entries.map((entry) => entry.code) },
            },
            include: { publishedRevision: { include: { options: true } } },
          });
    const byCode = new Map(rows.map((row) => [row.code, row]));
    const fields: ProductFormField[] = [];
    for (const entry of entries) {
      const row = byCode.get(entry.code);
      const published = row?.publishedRevision;
      if (row === undefined || published === null || published === undefined) continue;
      const bounds = published.bounds as {
        maxLength?: number;
        min?: number;
        max?: number;
        measure?: MeasureSettings;
      };
      fields.push({
        code: row.code,
        dataType: row.dataType,
        localizable: row.localizable,
        required: entry.required,
        isVariantOption: published.isVariantOption,
        bounds: {
          ...(bounds.maxLength === undefined ? {} : { maxLength: bounds.maxLength }),
          ...(bounds.min === undefined ? {} : { min: bounds.min }),
          ...(bounds.max === undefined ? {} : { max: bounds.max }),
        },
        ...(row.dataType === 'measure' && bounds.measure !== undefined
          ? { measure: bounds.measure }
          : {}),
        names: published.names as Record<string, string>,
        options: published.options
          .filter((option) => option.active)
          .sort((a, b) => a.position - b.position)
          .map((option) => ({
            code: option.optionCode,
            labels: option.labels as Record<string, string>,
          })),
      });
    }
    const categories = await tx.catalogPlatformCategory.findMany({
      where: { marketId: market.marketId, status: 'active', publishedRevisionId: { not: null } },
      include: { publishedRevision: { include: { names: true } } },
      orderBy: { slug: 'asc' },
    });
    return {
      fields,
      categories: categories.map((row) => ({
        categoryId: row.id,
        parentId: row.parentId,
        names: Object.fromEntries(
          (row.publishedRevision?.names ?? []).map((entry) => [entry.locale, entry.name]),
        ),
      })),
    };
  }
}
