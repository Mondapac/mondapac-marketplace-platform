import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import {
  SELLER_HEALTH_REQUEST_PAGE_MAX,
  type SellerHealthRequest,
  type SellerHealthRequestSource,
  type SellerHealthRequestStatus,
  type SellerHealthRequestStore,
} from '../application/ports/seller-health-request.store';

/** A stored request that breaks the rules: a fault of the data, never a value to use. */
export class StoredSellerHealthRequestError extends Error {
  override readonly name = 'StoredSellerHealthRequestError';
  constructor(column: string) {
    super(`sellers.seller_health_requests holds an invalid ${column}`);
  }
}

const SOURCES: readonly string[] = ['admin', 'seller'];
const STATUSES: readonly string[] = ['pending', 'done', 'failed'];

function requestOf(row: {
  id: string;
  sellerId: string;
  source: string;
  requestedAt: Date;
  status: string;
}): SellerHealthRequest {
  if (!SOURCES.includes(row.source)) throw new StoredSellerHealthRequestError('source');
  if (!STATUSES.includes(row.status)) throw new StoredSellerHealthRequestError('status');
  return {
    id: row.id as Id,
    sellerId: row.sellerId as Id<'Seller'>,
    source: row.source as SellerHealthRequestSource,
    requestedAt: Temporal.Instant.fromEpochMilliseconds(row.requestedAt.getTime()),
    status: row.status as SellerHealthRequestStatus,
  };
}

const SELECT = { id: true, sellerId: true, source: true, requestedAt: true, status: true } as const;

/** {@link SellerHealthRequestStore} on `sellers.seller_health_requests`, scoped by the Market. */
export class PrismaSellerHealthRequestStore implements SellerHealthRequestStore {
  constructor(private readonly prisma: PrismaService) {}

  async enqueue(
    market: MarketContext,
    request: Parameters<SellerHealthRequestStore['enqueue']>[1],
  ): Promise<{ readonly queued: boolean }> {
    // The partial unique index (one pending request per seller) turns a second click into no row.
    const created = await this.prisma.tx(market).sellersSellerHealthRequest.createMany({
      data: [
        {
          id: request.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          sellerId: request.sellerId,
          source: request.source,
          requestedByAccountId: request.byAccountId,
          requestedAt: new Date(request.at.epochMilliseconds),
          status: 'pending',
          finishedAt: null,
        },
      ],
      skipDuplicates: true,
    });
    return { queued: created.count > 0 };
  }

  async pending(market: MarketContext, limit: number): Promise<readonly SellerHealthRequest[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > SELLER_HEALTH_REQUEST_PAGE_MAX) {
      throw new RangeError('seller-health.requests: page size out of range');
    }
    const rows = await this.prisma.tx(market).sellersSellerHealthRequest.findMany({
      where: { marketId: market.marketId, status: 'pending' },
      orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: SELECT,
    });
    return rows.map(requestOf);
  }

  async finish(
    market: MarketContext,
    id: Id,
    status: 'done' | 'failed',
    at: Temporal.Instant,
  ): Promise<boolean> {
    const updated = await this.prisma.tx(market).sellersSellerHealthRequest.updateMany({
      where: { id, marketId: market.marketId, status: 'pending' },
      data: { status, finishedAt: new Date(at.epochMilliseconds) },
    });
    return updated.count > 0;
  }

  async purgeFinishedBefore(market: MarketContext, before: Temporal.Instant): Promise<number> {
    const deleted = await this.prisma.tx(market).sellersSellerHealthRequest.deleteMany({
      where: {
        marketId: market.marketId,
        status: { in: ['done', 'failed'] },
        requestedAt: { lt: new Date(before.epochMilliseconds) },
      },
    });
    return deleted.count;
  }

  async latest(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    source?: SellerHealthRequestSource,
  ): Promise<SellerHealthRequest | null> {
    const row = await this.prisma.tx(market).sellersSellerHealthRequest.findFirst({
      where: { marketId: market.marketId, sellerId, ...(source === undefined ? {} : { source }) },
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
      select: SELECT,
    });
    return row === null ? null : requestOf(row);
  }
}
