import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  MissingDetailsEmailDraft,
  MissingDetailsEmailEnd,
  MissingDetailsEmailKey,
  MissingDetailsEmailRecord,
  MissingDetailsEmailStore,
  PendingMissingDetailsEmail,
} from '../application/ports/missing-details-email.store';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

const STATES = ['pending', 'sent', 'skipped', 'failed'] as const;

function labelsOf(raw: unknown): readonly string[] {
  return Array.isArray(raw)
    ? raw.filter((label): label is string => typeof label === 'string')
    : [];
}

/** {@link MissingDetailsEmailStore} on `catalog.missing_details_emails`. */
export class PrismaMissingDetailsEmailStore implements MissingDetailsEmailStore {
  constructor(private readonly prisma: PrismaService) {}

  async latest(
    market: MarketContext,
    pairs: readonly MissingDetailsEmailKey[],
  ): Promise<readonly MissingDetailsEmailRecord[]> {
    if (pairs.length === 0) return [];
    const rows = await this.prisma.tx(market).catalogMissingDetailsEmail.findMany({
      where: {
        marketId: market.marketId,
        OR: pairs.map((pair) => ({ sellerId: pair.sellerId, productId: pair.productId })),
      },
      select: { sellerId: true, productId: true, state: true, requestedAt: true },
    });
    return rows.flatMap((row) => {
      const state = STATES.find((candidate) => candidate === row.state);
      return state === undefined
        ? []
        : [
            {
              sellerId: row.sellerId as Id<'Seller'>,
              productId: row.productId,
              state,
              requestedAt: toInstant(row.requestedAt),
            },
          ];
    });
  }

  async claim(
    market: MarketContext,
    draft: MissingDetailsEmailDraft,
    claim: {
      readonly requestedBy: Id<'Account'>;
      readonly now: Temporal.Instant;
      readonly notAfter: Temporal.Instant;
    },
  ): Promise<boolean> {
    const client = this.prisma.tx(market);
    const content = {
      sellerName: draft.sellerName,
      productName: draft.productName,
      missingLabels: [...draft.missingLabels],
      state: 'pending',
      outcome: null,
      attempts: 0,
      requestedAt: toDate(claim.now),
      requestedBy: claim.requestedBy,
      settledAt: null,
    };
    // A guarded update first: it locks the row, so two admins asking at once cannot both win.
    const replaced = await client.catalogMissingDetailsEmail.updateMany({
      where: {
        marketId: market.marketId,
        sellerId: draft.sellerId,
        productId: draft.productId,
        OR: [
          { requestedAt: { lte: toDate(claim.notAfter) } },
          { state: { in: ['skipped', 'failed'] } },
        ],
      },
      data: content,
    });
    if (replaced.count > 0) return true;
    // No such row yet (or a recent one, which the conflict leaves untouched).
    const inserted = await client.catalogMissingDetailsEmail.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          sellerId: draft.sellerId,
          productId: draft.productId,
          ...content,
        },
      ],
      skipDuplicates: true,
    });
    return inserted.count > 0;
  }

  async pending(
    market: MarketContext,
    limit: number,
  ): Promise<readonly PendingMissingDetailsEmail[]> {
    const rows = await this.prisma.tx(market).catalogMissingDetailsEmail.findMany({
      where: { marketId: market.marketId, state: 'pending' },
      orderBy: [{ requestedAt: 'asc' }, { sellerId: 'asc' }, { productId: 'asc' }],
      take: limit,
    });
    return rows.map((row) => ({
      sellerId: row.sellerId as Id<'Seller'>,
      productId: row.productId,
      sellerName: row.sellerName,
      productName: row.productName,
      missingLabels: labelsOf(row.missingLabels),
      attempts: row.attempts,
      requestedAt: toInstant(row.requestedAt),
    }));
  }

  async settle(
    market: MarketContext,
    key: MissingDetailsEmailKey,
    end: MissingDetailsEmailEnd | { readonly state: 'pending'; readonly attempts: number },
    now: Temporal.Instant,
  ): Promise<boolean> {
    const settled = end.state !== 'pending';
    const { count } = await this.prisma.tx(market).catalogMissingDetailsEmail.updateMany({
      where: {
        marketId: market.marketId,
        sellerId: key.sellerId,
        productId: key.productId,
        state: 'pending',
      },
      data: {
        state: end.state,
        outcome: 'outcome' in end ? end.outcome : null,
        attempts: end.attempts,
        settledAt: settled ? toDate(now) : null,
      },
    });
    return count > 0;
  }
}
