import type { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  ClaimOutcome,
  IdentifierClaimRepository,
} from '../application/ports/identifier-claim.repository';
import type { IdentifierIndexKey } from '../domain/business-identifier';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

/**
 * {@link IdentifierClaimRepository} on `sellers.identifier_claims` (data design 3.6). The insert is
 * `createMany … skipDuplicates` (`ON CONFLICT DO NOTHING`, covering the primary key and the
 * one-claim-per-seller key), so a refused claim leaves the unit's transaction usable; the holder
 * is then read to tell `already-mine` from `held-by-other`.
 */
export class PrismaIdentifierClaimRepository implements IdentifierClaimRepository {
  constructor(private readonly prisma: PrismaService) {}

  async take(
    market: MarketContext,
    claim: {
      readonly sellerId: Id<'Seller'>;
      readonly revisionId: Id<'BusinessFileRevision'>;
      readonly index: IdentifierIndexKey;
      readonly now: Temporal.Instant;
    },
  ): Promise<ClaimOutcome> {
    const tx = this.prisma.tx(market);
    const { count } = await tx.sellersIdentifierClaim.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          identifierIndex: Uint8Array.from(claim.index),
          sellerId: claim.sellerId,
          revisionId: claim.revisionId,
          claimedAt: toDate(claim.now),
          version: 1,
          createdAt: toDate(claim.now),
        },
      ],
      skipDuplicates: true,
    });
    if (count === 1) return 'taken';
    const holder = await this.holderOf(market, claim.index);
    if (holder === claim.sellerId) return 'already-mine';
    if (holder !== null) return 'held-by-other';
    // Nobody holds the value, yet nothing was inserted: the seller holds a claim on another value.
    throw new Error('sellers.identifier_claims: the seller already holds a claim on another value');
  }

  async release(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    revisionId: Id<'BusinessFileRevision'>,
  ): Promise<boolean> {
    const { count } = await this.prisma.tx(market).sellersIdentifierClaim.deleteMany({
      where: { marketId: market.marketId, sellerId, revisionId },
    });
    return count === 1;
  }

  async holderOf(market: MarketContext, index: IdentifierIndexKey): Promise<Id<'Seller'> | null> {
    const row = await this.prisma.tx(market).sellersIdentifierClaim.findFirst({
      where: { marketId: market.marketId, identifierIndex: Uint8Array.from(index) },
      select: { sellerId: true },
    });
    return row === null ? null : (row.sellerId as Id<'Seller'>);
  }
}
