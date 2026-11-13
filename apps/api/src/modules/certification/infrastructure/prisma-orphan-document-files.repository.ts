import type { MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { OrphanDocumentFilesRepository } from '../application/ports/orphan-document-files.repository';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const subjectOf = (key: string): string => key.split('/')[1] ?? '';

export class PrismaOrphanDocumentFilesRepository implements OrphanDocumentFilesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async unreferencedObjectKeys(
    market: MarketContext,
    keys: readonly string[],
  ): Promise<readonly string[]> {
    // A key whose subject is not a UUID is never ours; it is dropped before any query.
    const shaped = keys.filter((key) => UUID.test(subjectOf(key)));
    if (shaped.length === 0) return [];
    const tx = this.prisma.tx(market);
    const subjects = [...new Set(shaped.map(subjectOf))];
    const [sellers, platform, named] = await Promise.all([
      tx.certificationSellerCertification.findMany({
        where: { marketId: market.marketId, sellerId: { in: subjects } },
        select: { sellerId: true },
        distinct: ['sellerId'],
      }),
      tx.certificationPlatformSubject.findUnique({
        where: { marketId: market.marketId },
        select: { subjectId: true },
      }),
      tx.certificationUploadedDocument.findMany({
        where: { marketId: market.marketId, objectKey: { in: [...shaped] } },
        select: { objectKey: true },
      }),
    ]);
    const owned = new Set(sellers.map((row) => row.sellerId));
    if (platform !== null) owned.add(platform.subjectId);
    const referenced = new Set(named.map((row) => row.objectKey));
    return shaped.filter((key) => owned.has(subjectOf(key)) && !referenced.has(key));
  }
}
