import { Temporal } from '@mondapac/shared-kernel';
import type { ContentHash, Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { ProductRevisionRepository } from '../application/ports/product-revision.repository';
import type { SensitiveReason } from '../domain/product-revision-policy';
import type { RevisionContent } from '../domain/revision-content';
import type { RevisionKind, StoredRevision } from '../domain/stored-revision';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

/**
 * {@link ProductRevisionRepository} on `catalog.product_revisions` and its three child tables
 * (data design 3.7 to 3.10). Every statement goes through `PrismaService.tx(market)` with
 * `marketId` at the top level of `where`. The rows are insert-only (a trigger refuses any update
 * or delete), so nothing here updates.
 */
export class PrismaProductRevisionRepository implements ProductRevisionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async nextRevisionNo(market: MarketContext, productId: Id<'Product'>): Promise<number> {
    const top = await this.prisma.tx(market).catalogProductRevision.aggregate({
      where: { marketId: market.marketId, productId },
      _max: { revisionNo: true },
    });
    return (top._max.revisionNo ?? 0) + 1;
  }

  async add(market: MarketContext, revision: StoredRevision): Promise<void> {
    const { content } = revision;
    if (content.imageIds.length > 0) {
      throw new Error('ProductRevisionRepository: revision images arrive with slice 13');
    }
    const tx = this.prisma.tx(market);
    const base = { marketId: market.marketId, tenantId: market.tenantId };
    await tx.catalogProductRevision.create({
      data: {
        id: revision.id,
        ...base,
        productId: revision.productId,
        revisionNo: revision.revisionNo,
        revisionKind: revision.kind,
        baseRevisionId: revision.baseRevisionId,
        revertedFromRevisionId: revision.revertedFromRevisionId,
        familyRevisionId: content.schemaRef.familyRevisionId,
        definitionRevisionIds: [...content.schemaRef.definitionRevisionIds],
        taxCategoryCode: content.taxCategoryCode,
        attributeValues: content.attributeValues as object,
        sensitive: revision.sensitive,
        sensitiveReasons: [...revision.sensitiveReasons],
        contentSchemaVersion: content.contentSchemaVersion,
        contentHash: revision.contentHash,
        authorKind: revision.authorKind,
        authorAccountId: revision.authorAccountId,
        actingAdminAccountId: revision.actingAdminAccountId,
        submittedAt: toDate(revision.submittedAt),
      },
      select: { id: true },
    });
    await tx.catalogProductRevisionText.createMany({
      data: Object.entries(content.texts).map(([locale, text]) => ({
        ...base,
        revisionId: revision.id,
        locale,
        name: text.name,
        shortDescription: text.shortDescription,
        description: text.description,
      })),
    });
    await tx.catalogProductRevisionCategory.createMany({
      data: content.categoryIds.map((categoryId, index) => ({
        ...base,
        revisionId: revision.id,
        categoryId,
        position: index + 1,
      })),
    });
    await tx.catalogProductRevisionVariant.createMany({
      data: content.variants.map((variant) => ({
        ...base,
        revisionId: revision.id,
        productId: revision.productId,
        variantId: variant.variantId,
        position: variant.position,
        optionKey: variant.optionKey,
        optionValues: variant.optionValues,
        labels: variant.labels,
      })),
    });
  }

  async find(
    market: MarketContext,
    productId: Id<'Product'>,
    revisionId: Id<'ProductRevision'>,
  ): Promise<StoredRevision | null> {
    const row = await this.prisma.tx(market).catalogProductRevision.findFirst({
      where: { marketId: market.marketId, productId, id: revisionId },
      include: {
        texts: { orderBy: { locale: 'asc' } },
        categories: { orderBy: { position: 'asc' } },
        variants: { orderBy: { position: 'asc' } },
      },
    });
    if (row === null) return null;
    const content: RevisionContent = {
      texts: Object.fromEntries(
        row.texts.map((text) => [
          text.locale,
          {
            name: text.name,
            shortDescription: text.shortDescription,
            description: text.description,
          },
        ]),
      ),
      categoryIds: row.categories.map((category) => category.categoryId),
      taxCategoryCode: row.taxCategoryCode,
      attributeValues: row.attributeValues as Record<string, unknown>,
      variants: row.variants.map((variant) => ({
        variantId: variant.variantId,
        position: variant.position,
        optionKey: variant.optionKey,
        optionValues: variant.optionValues as Record<string, string>,
        labels: variant.labels as Record<string, string>,
      })),
      imageIds: [],
      schemaRef: {
        familyRevisionId: row.familyRevisionId,
        definitionRevisionIds: row.definitionRevisionIds,
      },
      contentSchemaVersion: row.contentSchemaVersion,
    };
    return {
      id: row.id as Id<'ProductRevision'>,
      productId: row.productId as Id<'Product'>,
      revisionNo: row.revisionNo,
      kind: row.revisionKind as RevisionKind,
      baseRevisionId: row.baseRevisionId as Id<'ProductRevision'> | null,
      revertedFromRevisionId: row.revertedFromRevisionId as Id<'ProductRevision'> | null,
      sensitive: row.sensitive,
      sensitiveReasons: row.sensitiveReasons as SensitiveReason[],
      contentHash: row.contentHash as ContentHash,
      authorKind: row.authorKind as 'seller' | 'admin',
      authorAccountId: row.authorAccountId as Id<'Account'>,
      actingAdminAccountId: row.actingAdminAccountId as Id<'Account'> | null,
      submittedAt: toInstant(row.submittedAt),
      content,
    };
  }
}
