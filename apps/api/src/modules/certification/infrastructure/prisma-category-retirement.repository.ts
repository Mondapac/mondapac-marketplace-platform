import { ok } from '@mondapac/shared-kernel';
import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type {
  CategoryRetirementRepository,
  PolicyNamedCategory,
} from '../application/ports/category-retirement.repository';

/** Bases whose row stops matching when its category goes, so the claim could relax (design 3.7). */
const RELAXING_BASES = ['NOT_APPLICABLE', 'SELLER_REQUIRED'] as const;

/**
 * {@link CategoryRetirementRepository} on `certification.claim_policy_rows` (data design A12):
 * rows with `category_id = ANY($ids)` (partial index `(market_id, category_id)`) whose revision is
 * a policy's published one or the proposed revision of a `pending` `claim-policy-revision`
 * proposal. Every query names the Market.
 */
export class PrismaCategoryRetirementRepository implements CategoryRetirementRepository {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly prisma: PrismaService,
  ) {}

  async blockingTypeCodes(
    market: MarketContext,
    categoryIds: readonly Id<'Category'>[],
  ): Promise<readonly string[]> {
    const result = await this.unitOfWork.run(
      market,
      async () => {
        const rows = await this.namedRows(market, categoryIds, RELAXING_BASES);
        const codes = new Set(rows.map((row) => row.revision.policy.type.code));
        return ok([...codes].sort());
      },
      { readOnly: true },
    );
    if (!result.ok) throw new Error('read unit answered an error');
    return result.value;
  }

  async namedCategories(
    market: MarketContext,
    categoryIds: readonly Id<'Category'>[],
  ): Promise<readonly PolicyNamedCategory[]> {
    const rows = await this.namedRows(market, categoryIds, null);
    const byCategory = new Map<string, boolean>();
    for (const row of rows) {
      if (row.categoryId === null) continue;
      const relaxing = (RELAXING_BASES as readonly string[]).includes(row.basis);
      byCategory.set(row.categoryId, (byCategory.get(row.categoryId) ?? false) || relaxing);
    }
    return [...byCategory.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([categoryId, relaxingRowNamed]) => ({
        categoryId: categoryId as Id<'Category'>,
        relaxingRowNamed,
      }));
  }

  async insertFlags(
    market: MarketContext,
    categoryIds: readonly Id<'Category'>[],
    reportedAt: Temporal.Instant,
  ): Promise<readonly Id<'Category'>[]> {
    if (categoryIds.length === 0) return [];
    const at = new Date(reportedAt.epochMilliseconds);
    const inserted = await this.prisma
      .tx(market)
      .certificationRetiredCategoryFlag.createManyAndReturn({
        data: categoryIds.map((categoryId) => ({
          marketId: market.marketId,
          tenantId: market.tenantId,
          categoryId,
          reportedAt: at,
        })),
        skipDuplicates: true,
        select: { categoryId: true },
      });
    return inserted.map((row) => row.categoryId as Id<'Category'>).sort();
  }

  /** The published and pending revisions' category rows on the ids, with their type code. */
  private async namedRows(
    market: MarketContext,
    categoryIds: readonly Id<'Category'>[],
    bases: readonly string[] | null,
  ) {
    if (categoryIds.length === 0) return [];
    const tx = this.prisma.tx(market);
    const pending = await tx.certificationRelaxationProposal.findMany({
      where: {
        marketId: market.marketId,
        subjectKind: 'claim-policy-revision',
        state: 'pending',
        proposedRevisionId: { not: null },
      },
      select: { proposedRevisionId: true },
    });
    const pendingRevisionIds = pending.flatMap((row) =>
      row.proposedRevisionId === null ? [] : [row.proposedRevisionId],
    );
    return tx.certificationClaimPolicyRow.findMany({
      where: {
        marketId: market.marketId,
        selectorKind: 'platform-category',
        categoryId: { in: [...categoryIds] },
        ...(bases === null ? {} : { basis: { in: [...bases] } }),
        OR: [
          { revision: { publishedOf: { some: { marketId: market.marketId } } } },
          ...(pendingRevisionIds.length === 0 ? [] : [{ revisionId: { in: pendingRevisionIds } }]),
        ],
      },
      select: {
        categoryId: true,
        basis: true,
        revision: { select: { policy: { select: { type: { select: { code: true } } } } } },
      },
    });
  }
}
