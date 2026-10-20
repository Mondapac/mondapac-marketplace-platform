import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { PublishedStoreRepository } from '../application/ports/published-store.repository';
import type { ApprovedStoreFacts } from '../domain/published-store';

/** The revision statuses a revision can have once it was approved (a later one supersedes it). */
const ONCE_APPROVED = ['approved', 'superseded'];

/**
 * {@link PublishedStoreRepository} on `sellers.seller_files`, `shop_slugs` and
 * `business_file_revisions`, clear columns only. The approved pointer is the authority (data
 * design 3.1); the revision it names must be `approved` and of the same seller, and the seller
 * must hold a slug, else the store is absent (fail closed). Separate snapshots are safe: an
 * approved revision never changes (A18) and a slug change is seen by the next call.
 */
export class PrismaPublishedStoreRepository implements PublishedStoreRepository {
  constructor(private readonly prisma: PrismaService) {}

  async approvedStores(
    market: MarketContext,
    limit: number,
  ): Promise<readonly ApprovedStoreFacts[]> {
    // Pages of approved files by seller id, until `limit` stores qualify: a file left out (no held
    // slug, a faulty pointer) must not shorten the answer below the limit.
    const facts: ApprovedStoreFacts[] = [];
    let after: string | undefined;
    while (facts.length < limit) {
      const files = await this.prisma.tx(market).sellersSellerFile.findMany({
        where: {
          marketId: market.marketId,
          approvedRevisionId: { not: null },
          publicStoreName: { not: null },
          ...(after === undefined ? {} : { sellerId: { gt: after } }),
        },
        select: { sellerId: true, approvedRevisionId: true, publicStoreName: true },
        orderBy: { sellerId: 'asc' },
        take: limit,
      });
      facts.push(...(await this.#facts(market, files)));
      if (files.length < limit) break;
      after = files[files.length - 1]?.sellerId;
    }
    return facts.slice(0, limit);
  }

  async approvedStoreBySlug(
    market: MarketContext,
    slug: string,
  ): Promise<ApprovedStoreFacts | null> {
    const tx = this.prisma.tx(market);
    const held = await tx.sellersShopSlug.findFirst({
      where: { marketId: market.marketId, slug, state: 'held' },
      select: { sellerId: true },
    });
    if (held === null) return null;
    const files = await tx.sellersSellerFile.findMany({
      where: {
        marketId: market.marketId,
        sellerId: held.sellerId,
        approvedRevisionId: { not: null },
        publicStoreName: { not: null },
      },
      select: { sellerId: true, approvedRevisionId: true, publicStoreName: true },
    });
    const [facts] = await this.#facts(market, files);
    return facts?.slug === slug ? facts : null;
  }

  async #facts(
    market: MarketContext,
    files: readonly {
      sellerId: string;
      approvedRevisionId: string | null;
      publicStoreName: string | null;
    }[],
  ): Promise<ApprovedStoreFacts[]> {
    if (files.length === 0) return [];
    const tx = this.prisma.tx(market);
    const sellerIds = files.map((row) => row.sellerId);
    const slugs = await tx.sellersShopSlug.findMany({
      where: { marketId: market.marketId, sellerId: { in: sellerIds }, state: 'held' },
      select: { sellerId: true, slug: true },
    });
    const revisions = await tx.sellersBusinessFileRevision.findMany({
      where: {
        marketId: market.marketId,
        sellerId: { in: sellerIds },
        id: { in: files.flatMap((row) => row.approvedRevisionId ?? []) },
        status: 'approved',
      },
      select: { id: true, sellerId: true, serviceAreaCode: true, operatingTimezone: true },
    });
    const firsts = await tx.sellersBusinessFileRevision.groupBy({
      by: ['sellerId'],
      where: {
        marketId: market.marketId,
        sellerId: { in: sellerIds },
        status: { in: ONCE_APPROVED },
        decidedAt: { not: null },
      },
      _min: { decidedAt: true },
    });
    const slugOf = new Map(slugs.map((row) => [row.sellerId, row.slug]));
    const revisionOf = new Map(revisions.map((row) => [row.id, row]));
    const firstOf = new Map(firsts.map((row) => [row.sellerId, row._min.decidedAt]));
    const facts: ApprovedStoreFacts[] = [];
    for (const file of files) {
      const revision = revisionOf.get(file.approvedRevisionId ?? '');
      const slug = slugOf.get(file.sellerId);
      const first = firstOf.get(file.sellerId);
      // A pointer to another seller's revision, a missing slug or a missing decision instant is
      // a fault of the data: the store stays absent (fail closed).
      if (revision === undefined || revision.sellerId !== file.sellerId) continue;
      if (slug === undefined || first === undefined || first === null) continue;
      if (file.publicStoreName === null) continue;
      facts.push({
        sellerId: file.sellerId as Id<'Seller'>,
        slug,
        name: file.publicStoreName,
        serviceAreaCode: revision.serviceAreaCode,
        operatingTimezone: revision.operatingTimezone,
        firstApprovedAt: Temporal.Instant.fromEpochMilliseconds(first.getTime()),
      });
    }
    return facts;
  }
}
