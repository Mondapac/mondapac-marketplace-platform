import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../../platform/persistence/prisma.service';
import type {
  AccessReviewer,
  ReviewerCandidateReader,
} from '../../application/ports/access-reviewers';

/**
 * {@link ReviewerCandidateReader} on `identity.accounts` (identity design 8.7; data design 3.3):
 * one statement through `PrismaService.tx(market)` with `marketId` at the top level of `where`,
 * so the market guard checks it (P 4). It reads the id and the address only: never the
 * credential, never a row of another module. The `(market_id, population, email_normalized)`
 * unique index serves the Market and population prefix; a Market holds 10² admin rows or fewer,
 * so no index of its own is needed.
 */
export class PrismaReviewerCandidateReader implements ReviewerCandidateReader {
  constructor(private readonly prisma: PrismaService) {}

  async activeVerifiedAdmins(market: MarketContext, limit: number): Promise<AccessReviewer[]> {
    const rows = await this.prisma.tx(market).identityAccount.findMany({
      where: {
        marketId: market.marketId,
        population: 'admin',
        status: 'active',
        emailVerifiedAt: { not: null },
      },
      select: { id: true, email: true },
      orderBy: { id: 'asc' },
      take: limit,
    });
    return rows.map((row) => ({ accountId: row.id as Id<'Account'>, email: row.email }));
  }
}
