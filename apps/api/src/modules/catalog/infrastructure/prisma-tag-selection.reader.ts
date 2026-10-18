import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  CertificateOfferOwner,
  StaleTag,
  TagSelection,
  TagSelectionReader,
} from '../application/ports/tag-selection.reader';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

/** The column a selection matches (data design 3.15 selection indexes). */
function selected(selection: TagSelection): Prisma.CatalogOfferTagWhereInput {
  switch (selection.by) {
    case 'certificate':
      return { certificateId: selection.id };
    case 'certificate-version':
      return { certificateVersionId: selection.id };
    case 'seller':
      return { sellerId: selection.id };
    case 'type':
      return { typeCode: selection.code };
  }
}

/**
 * {@link TagSelectionReader} on `catalog.offer_tags` (data design 3.15, slice 12). The handler
 * selections repeat the partial-index predicate literally (`status <> 'removed' AND
 * copy_revision_published`); the reconciliation repeats `status NOT IN ('removed',
 * 'pending-publish')` and joins the copy's revision decision (`outcome = 'published'`) instead of
 * trusting the flag. No raw SQL (6.3); the plans hold under unnamed statements (platform.md 10.9).
 */
export class PrismaTagSelectionReader implements TagSelectionReader {
  constructor(private readonly prisma: PrismaService) {}

  async selectedOffers(
    market: MarketContext,
    selection: TagSelection,
    page: {
      readonly afterId: Id<'Offer'> | null;
      readonly limit: number;
      readonly activeOnly?: boolean;
    },
  ): Promise<readonly Id<'Offer'>[]> {
    const groups = await this.prisma.tx(market).catalogOfferTag.groupBy({
      by: ['offerId'],
      where: {
        marketId: market.marketId,
        ...selected(selection),
        // The partial-index predicate, literally; `activeOnly` adds a filter inside it.
        status: { not: 'removed' },
        ...(page.activeOnly === true ? { AND: [{ status: 'active' }] } : {}),
        copyRevisionPublished: true,
        ...(page.afterId === null ? {} : { offerId: { gt: page.afterId } }),
      },
      orderBy: { offerId: 'asc' },
      take: page.limit,
    });
    return groups.map((group) => group.offerId as Id<'Offer'>);
  }

  async ownersOfCertificate(
    market: MarketContext,
    certificateId: Id,
    limit: number,
  ): Promise<readonly CertificateOfferOwner[]> {
    // The certificate selection index (`offer_tags_market_id_certificate_id_idx`) with its
    // partial predicate repeated literally; `active` and the kind filter inside it.
    const groups = await this.prisma.tx(market).catalogOfferTag.groupBy({
      by: ['sellerId', 'typeCode'],
      where: {
        marketId: market.marketId,
        certificateId,
        status: { not: 'removed' },
        AND: [{ status: 'active' }, { certificateKind: 'manufacturer' }],
        copyRevisionPublished: true,
      },
      _count: { offerId: true },
      _min: { validUntil: true },
      orderBy: [{ sellerId: 'asc' }, { typeCode: 'asc' }],
      take: limit,
    });
    return groups.map((group) => ({
      sellerId: group.sellerId as Id<'Seller'>,
      typeCode: group.typeCode,
      offers: group._count.offerId,
      validUntil:
        group._min.validUntil === null
          ? null
          : Temporal.Instant.fromEpochMilliseconds(group._min.validUntil.getTime()),
    }));
  }

  async staleTags(
    market: MarketContext,
    page: {
      readonly before: Temporal.Instant;
      readonly after: { readonly evaluatedAt: Temporal.Instant; readonly tagId: Id } | null;
      readonly limit: number;
    },
  ): Promise<readonly StaleTag[]> {
    const after = page.after;
    const position: Prisma.CatalogOfferTagWhereInput =
      after === null
        ? { evaluatedAt: { lt: toDate(page.before) } }
        : {
            // The redundant lower bound keeps the keyset inside the index condition.
            evaluatedAt: { lt: toDate(page.before), gte: toDate(after.evaluatedAt) },
            OR: [
              { evaluatedAt: { gt: toDate(after.evaluatedAt) } },
              { evaluatedAt: toDate(after.evaluatedAt), id: { gt: after.tagId } },
            ],
          };
    const rows = await this.prisma.tx(market).catalogOfferTag.findMany({
      where: {
        marketId: market.marketId,
        status: { notIn: ['removed', 'pending-publish'] },
        ...position,
        copyRevision: { is: { decision: { is: { outcome: 'published' } } } },
      },
      orderBy: [{ evaluatedAt: 'asc' }, { id: 'asc' }],
      take: page.limit,
      select: { id: true, offerId: true, evaluatedAt: true },
    });
    return rows.map((row) => ({
      tagId: row.id as Id<'OfferTag'>,
      offerId: row.offerId as Id<'Offer'>,
      evaluatedAt: Temporal.Instant.fromEpochMilliseconds(row.evaluatedAt.getTime()),
    }));
  }
}
