import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { StaleAggregateError } from '../../../platform/unit-of-work/errors';
import type {
  CategoryChange,
  CategoryEditStore,
  NewCategory,
} from '../application/ports/category-edit.store';
import type { CategoryText, EditableCategory } from '../domain/category-edit';
import type { CategoryStatus } from '../domain/platform-category';

const toDate = (instant: { readonly epochMilliseconds: number }): Date =>
  new Date(instant.epochMilliseconds);

/** A value no sibling holds: the parking place of a swap (positions are small, CHECK >= 0). */
const PARKING_POSITION = 2_000_000_000;
const RETIRED_SLUG_HOLD_MONTHS = 12;

/**
 * {@link CategoryEditStore} on `catalog.platform_categories` and its insert-only revision tables
 * (C2 model, C3a grants). Every statement goes through `PrismaService.tx(market)` with `marketId`
 * at the top level of `where`; the texts row is written before the name row so the C2 trigger
 * (`ON CONFLICT DO NOTHING`) never keeps a bare name over a full text.
 */
export class PrismaCategoryEditStore implements CategoryEditStore {
  constructor(private readonly prisma: PrismaService) {}

  async loadAll(market: MarketContext, limit: number): Promise<readonly EditableCategory[]> {
    const rows = await this.prisma.tx(market).catalogPlatformCategory.findMany({
      where: { marketId: market.marketId },
      select: {
        id: true,
        parentId: true,
        slug: true,
        status: true,
        hiddenById: true,
        position: true,
        version: true,
        createdByKind: true,
        showInMenu: true,
        imageId: true,
        seoTitle: true,
        seoDescription: true,
        seoNoindex: true,
        publishedRevision: {
          select: {
            revisionNo: true,
            texts: {
              select: { locale: true, name: true, shortDescription: true, keywords: true },
            },
          },
        },
      },
      orderBy: { id: 'asc' },
      take: limit,
    });
    return rows.map((row) => ({
      id: row.id as Id<'Category'>,
      parentId: row.parentId as Id<'Category'> | null,
      slug: row.slug,
      status: row.status as CategoryStatus,
      hiddenById: row.hiddenById as Id<'Category'> | null,
      position: row.position,
      version: row.version,
      revisionNo: row.publishedRevision?.revisionNo ?? 0,
      createdByKind: row.createdByKind as 'seed' | 'admin',
      showInMenu: row.showInMenu,
      imageId: row.imageId,
      seo: { title: row.seoTitle, description: row.seoDescription, noindex: row.seoNoindex },
      texts: [...(row.publishedRevision?.texts ?? [])]
        .sort((a, b) => (a.locale < b.locale ? -1 : 1))
        .map((text): CategoryText => ({
          locale: text.locale,
          name: text.name,
          shortDescription: text.shortDescription,
          keywords: text.keywords,
        })),
    }));
  }

  async lockSlugs(market: MarketContext, slugs: readonly string[]): Promise<void> {
    for (const slug of [...new Set(slugs)].sort()) {
      await this.prisma.namedQuery(market, 'catalog.lock-category-slug', { slug });
    }
  }

  async slugUnavailable(
    market: MarketContext,
    slug: string,
    exceptId: Id<'Category'> | null,
    now: Temporal.Instant,
  ): Promise<boolean> {
    const tx = this.prisma.tx(market);
    const current = await tx.catalogPlatformCategory.findFirst({
      where: {
        marketId: market.marketId,
        slug,
        ...(exceptId === null ? {} : { id: { not: exceptId } }),
      },
      select: { id: true },
    });
    if (current !== null) return true;
    const since = toDate(
      now.toZonedDateTimeISO('UTC').subtract({ months: RETIRED_SLUG_HOLD_MONTHS }).toInstant(),
    );
    const retired = await tx.catalogPlatformCategorySlugHistory.findFirst({
      where: {
        marketId: market.marketId,
        slug,
        retiredAt: { gt: since },
        ...(exceptId === null ? {} : { categoryId: { not: exceptId } }),
      },
      select: { slug: true },
    });
    return retired !== null;
  }

  async discardFacts(
    market: MarketContext,
    id: Id<'Category'>,
  ): Promise<{ readonly everShown: boolean; readonly productRevisions: number }> {
    const tx = this.prisma.tx(market);
    const shown = await tx.catalogPlatformCategoryRevision.findFirst({
      where: { marketId: market.marketId, categoryId: id, changeKind: 'shown' },
      select: { id: true },
    });
    const productRevisions = await tx.catalogProductRevisionCategory.count({
      where: { marketId: market.marketId, categoryId: id },
    });
    return { everShown: shown !== null, productRevisions };
  }

  async insert(market: MarketContext, category: NewCategory): Promise<void> {
    const tx = this.prisma.tx(market);
    await tx.catalogPlatformCategory.create({
      data: {
        id: category.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        parentId: category.parentId,
        verticalRootCode: null,
        slug: category.slug,
        status: 'hidden',
        mergedIntoId: null,
        publishedRevisionId: null,
        createdByKind: 'admin',
        version: 1,
        createdAt: toDate(category.now),
        // -1 = last among the siblings: the database numbers it under a lock (C2).
        position: -1,
        showInMenu: category.showInMenu,
        seoTitle: category.seo.title,
        seoDescription: category.seo.description,
        seoNoindex: category.seo.noindex,
      },
      select: { id: true },
    });
    await tx.catalogPlatformCategoryRevision.create({
      data: {
        id: category.revisionId,
        marketId: market.marketId,
        tenantId: market.tenantId,
        categoryId: category.id,
        revisionNo: 1,
        parentId: category.parentId,
        changeKind: 'created',
        authorKind: 'admin',
        authorAccountId: category.authorAccountId,
        createdAt: toDate(category.now),
      },
      select: { id: true },
    });
    await this.#writeTexts(market, category.revisionId, category.texts);
    const { count } = await tx.catalogPlatformCategory.updateMany({
      where: { marketId: market.marketId, id: category.id, version: 1 },
      data: { publishedRevisionId: category.revisionId },
    });
    if (count !== 1) throw new StaleAggregateError('platform-category', category.id);
  }

  async apply(market: MarketContext, change: CategoryChange): Promise<number> {
    const { category, patch } = change;
    const tx = this.prisma.tx(market);
    const revisionNo = category.revisionNo + 1;
    const version = category.version + 1;
    // The guarded update comes first: it takes the row lock, so a second admin with the same
    // version waits here and then loses with a stale error, instead of meeting the unique
    // (category, revision_no) of the revision the first one wrote.
    const { count } = await tx.catalogPlatformCategory.updateMany({
      where: { marketId: market.marketId, id: category.id, version: category.version },
      data: {
        version,
        ...(patch.status === undefined ? {} : { status: patch.status }),
        ...(patch.hiddenById === undefined ? {} : { hiddenById: patch.hiddenById }),
        ...(patch.position === undefined ? {} : { position: patch.position }),
        ...(patch.showInMenu === undefined ? {} : { showInMenu: patch.showInMenu }),
        ...(patch.imageId === undefined ? {} : { imageId: patch.imageId }),
        ...(patch.slug === undefined ? {} : { slug: patch.slug }),
        ...(patch.seo === undefined
          ? {}
          : {
              seoTitle: patch.seo.title,
              seoDescription: patch.seo.description,
              seoNoindex: patch.seo.noindex,
            }),
      },
    });
    if (count !== 1) throw new StaleAggregateError('platform-category', category.id);
    await tx.catalogPlatformCategoryRevision.create({
      data: {
        id: change.revisionId,
        marketId: market.marketId,
        tenantId: market.tenantId,
        categoryId: category.id,
        revisionNo,
        parentId: category.parentId,
        changeKind: change.kind,
        authorKind: 'admin',
        authorAccountId: change.authorAccountId,
        createdAt: toDate(change.now),
      },
      select: { id: true },
    });
    await this.#writeTexts(market, change.revisionId, change.texts);
    const pointed = await tx.catalogPlatformCategory.updateMany({
      where: { marketId: market.marketId, id: category.id, version },
      data: { publishedRevisionId: change.revisionId },
    });
    if (pointed.count !== 1) throw new StaleAggregateError('platform-category', category.id);
    return version;
  }

  async retireSlug(
    market: MarketContext,
    id: Id<'Category'>,
    slug: string,
    at: { readonly epochMilliseconds: number },
  ): Promise<void> {
    await this.prisma.tx(market).catalogPlatformCategorySlugHistory.create({
      data: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        slug,
        categoryId: id,
        retiredAt: toDate(at),
      },
      select: { slug: true },
    });
  }

  async swapPositions(
    market: MarketContext,
    a: EditableCategory,
    b: EditableCategory,
  ): Promise<void> {
    const tx = this.prisma.tx(market);
    const move = async (id: string, from: number, to: number): Promise<void> => {
      const { count } = await tx.catalogPlatformCategory.updateMany({
        where: { marketId: market.marketId, id, position: from },
        data: { position: to },
      });
      if (count !== 1) throw new StaleAggregateError('platform-category', id);
    };
    await move(a.id, a.position, PARKING_POSITION);
    await move(b.id, b.position, a.position);
    await move(a.id, PARKING_POSITION, b.position);
  }

  async #writeTexts(
    market: MarketContext,
    revisionId: Id<'CategoryRevision'>,
    texts: readonly CategoryText[],
  ): Promise<void> {
    const tx = this.prisma.tx(market);
    await tx.catalogPlatformCategoryRevisionText.createMany({
      data: texts.map((text) => ({
        marketId: market.marketId,
        tenantId: market.tenantId,
        revisionId,
        locale: text.locale,
        name: text.name,
        shortDescription: text.shortDescription,
        keywords: [...text.keywords],
      })),
    });
    // After the texts: the C2 trigger copies a name row into the texts with ON CONFLICT DO NOTHING.
    await tx.catalogPlatformCategoryRevisionName.createMany({
      data: texts.map((text) => ({
        marketId: market.marketId,
        tenantId: market.tenantId,
        revisionId,
        locale: text.locale,
        name: text.name,
      })),
    });
  }
}
