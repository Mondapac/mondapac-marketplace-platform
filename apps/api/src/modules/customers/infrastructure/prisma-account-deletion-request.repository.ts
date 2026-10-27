import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { AccountDeletionRequestRepository } from '../application/ports/account-deletion-request.repository';
import type {
  AccountDeletionRequest,
  AccountDeletionRequestStatus,
} from '../domain/account-deletion-request';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

const toRequest = (row: {
  readonly id: string;
  readonly accountId: string;
  readonly status: string;
  readonly waitingPeriodDays: number;
  readonly requestedAt: Date;
  readonly scheduledFor: Date;
}): AccountDeletionRequest => ({
  id: row.id as Id<'AccountDeletionRequest'>,
  accountId: row.accountId as Id<'Account'>,
  status: row.status as AccountDeletionRequestStatus,
  waitingPeriodDays: row.waitingPeriodDays,
  requestedAt: toInstant(row.requestedAt),
  scheduledFor: toInstant(row.scheduledFor),
});

/** {@link AccountDeletionRequestRepository} on `customers.account_deletion_requests`, scoped by `marketId`. */
export class PrismaAccountDeletionRequestRepository implements AccountDeletionRequestRepository {
  constructor(private readonly prisma: PrismaService) {}

  async insertPending(market: MarketContext, request: AccountDeletionRequest): Promise<boolean> {
    // ON CONFLICT DO NOTHING answers the partial unique index (one pending request per account).
    const created = await this.prisma.tx(market).customersAccountDeletionRequest.createMany({
      data: [
        {
          id: request.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          accountId: request.accountId,
          status: 'pending',
          waitingPeriodDays: request.waitingPeriodDays,
          requestedAt: toDate(request.requestedAt),
          scheduledFor: toDate(request.scheduledFor),
        },
      ],
      skipDuplicates: true,
    });
    return created.count === 1;
  }

  async findPendingOf(market: MarketContext, accountId: Id<'Account'>) {
    const row = await this.prisma.tx(market).customersAccountDeletionRequest.findFirst({
      where: { marketId: market.marketId, accountId, status: 'pending' },
    });
    return row === null ? null : toRequest(row);
  }

  async cancel(
    market: MarketContext,
    id: Id<'AccountDeletionRequest'>,
    reason: 'customer' | 'sign-in',
    at: Temporal.Instant,
  ): Promise<boolean> {
    const { count } = await this.prisma.tx(market).customersAccountDeletionRequest.updateMany({
      where: { marketId: market.marketId, id, status: 'pending' },
      data: { status: 'cancelled', cancelledAt: toDate(at), cancelReason: reason },
    });
    return count === 1;
  }

  async complete(
    market: MarketContext,
    id: Id<'AccountDeletionRequest'>,
    at: Temporal.Instant,
  ): Promise<boolean> {
    const { count } = await this.prisma.tx(market).customersAccountDeletionRequest.updateMany({
      where: { marketId: market.marketId, id, status: 'pending' },
      data: { status: 'completed', completedAt: toDate(at) },
    });
    return count === 1;
  }

  async listDue(market: MarketContext, now: Temporal.Instant, limit: number) {
    const rows = await this.prisma.tx(market).customersAccountDeletionRequest.findMany({
      where: { marketId: market.marketId, status: 'pending', scheduledFor: { lte: toDate(now) } },
      orderBy: [{ scheduledFor: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return rows.map(toRequest);
  }
}
