import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../../platform/persistence/prisma.service';
import type {
  SellerMemberSummary,
  SellerTeamReader,
} from '../../application/ports/seller-team-reader';

/**
 * {@link SellerTeamReader} on `identity.accounts` filtered by an active membership of the seller
 * (data design 3.3, 3.9; slice 11): one statement through `PrismaService.tx(market)` with
 * `marketId` at the top level of `where`, over identity's own tables. It reads the id, the
 * address and the name: never the credential. A seller's team is small, and the membership side
 * is served by `seller_memberships_market_id_seller_id_state_idx`.
 */
export class PrismaSellerTeamReader implements SellerTeamReader {
  constructor(private readonly prisma: PrismaService) {}

  async activeMembers(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    after: Id<'Account'> | null,
    limit: number,
  ): Promise<SellerMemberSummary[]> {
    const rows = await this.prisma.tx(market).identityAccount.findMany({
      where: {
        marketId: market.marketId,
        population: 'seller',
        sellerMemberships: { some: { marketId: market.marketId, sellerId, state: 'active' } },
        ...(after === null ? {} : { id: { gt: after } }),
      },
      select: { id: true, email: true, displayName: true },
      orderBy: { id: 'asc' },
      take: limit,
    });
    return rows.map((row) => ({
      accountId: row.id as Id<'Account'>,
      email: row.email,
      displayName: row.displayName,
    }));
  }
}
