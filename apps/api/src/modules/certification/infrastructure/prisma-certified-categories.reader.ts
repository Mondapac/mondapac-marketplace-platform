import { ok } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { CertifiedCategoriesReader } from '../application/ports/certified-categories.reader';

/**
 * {@link CertifiedCategoriesReader} on `certification.claim_policy_rows`: the category rows of the
 * published revision of every policy of the Market whose basis is not `NOT_APPLICABLE`. It opens
 * a read-only unit of its own for the read (ADR-0025); a fault rejects, so the caller answers
 * `unavailable`.
 */
export class PrismaCertifiedCategoriesReader implements CertifiedCategoriesReader {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly prisma: PrismaService,
  ) {}

  async categoryIds(market: MarketContext): Promise<readonly Id<'Category'>[]> {
    const result = await this.unitOfWork.run(
      market,
      async () => {
        const rows = await this.prisma.tx(market).certificationClaimPolicyRow.findMany({
          where: {
            marketId: market.marketId,
            selectorKind: 'platform-category',
            categoryId: { not: null },
            basis: { not: 'NOT_APPLICABLE' },
            revision: { publishedOf: { some: { marketId: market.marketId } } },
          },
          select: { categoryId: true },
        });
        const ids = rows.flatMap((row) => (row.categoryId === null ? [] : [row.categoryId]));
        return ok([...new Set(ids)].sort() as Id<'Category'>[]);
      },
      { readOnly: true },
    );
    if (!result.ok) throw new Error('read unit answered an error');
    return result.value;
  }
}
