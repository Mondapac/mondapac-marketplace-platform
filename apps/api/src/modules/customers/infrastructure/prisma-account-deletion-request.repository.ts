import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  AccountDeletionRequestRepository,
  PendingCursor,
} from '../application/ports/account-deletion-request.repository';
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
  readonly claimedAt: Date | null;
  readonly requestedBy: string;
  readonly adminAccountId: string | null;
  readonly ticketRef: string | null;
  readonly reason: string | null;
}): AccountDeletionRequest => ({
  id: row.id as Id<'AccountDeletionRequest'>,
  accountId: row.accountId as Id<'Account'>,
  status: row.status as AccountDeletionRequestStatus,
  waitingPeriodDays: row.waitingPeriodDays,
  requestedAt: toInstant(row.requestedAt),
  scheduledFor: toInstant(row.scheduledFor),
  claimedAt: row.claimedAt === null ? null : toInstant(row.claimedAt),
  requestedBy: row.requestedBy === 'admin' ? 'admin' : 'customer',
  adminOrigin:
    row.adminAccountId === null || row.ticketRef === null
      ? null
      : {
          adminAccountId: row.adminAccountId as Id<'Account'>,
          ticketRef: row.ticketRef,
          reason: row.reason,
        },
});

/** The two closing writes an admin-origin row needs: the free text goes, the ticket reference stays. */
const REDACTION = (at: Temporal.Instant) => ({ reason: null, redactedAt: toDate(at) });

/** {@link AccountDeletionRequestRepository} on `customers.account_deletion_requests`, scoped by `marketId`. */
export class PrismaAccountDeletionRequestRepository implements AccountDeletionRequestRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Redacts the admin-entered reason of a request that was just closed (cancelled or completed): in
   * the unit of the closing write, so a closed admin row never keeps the text. A buyer's own request
   * holds none and is left as it is.
   */
  async #redactClosed(
    market: MarketContext,
    id: Id<'AccountDeletionRequest'>,
    at: Temporal.Instant,
  ) {
    await this.prisma.tx(market).customersAccountDeletionRequest.updateMany({
      where: {
        marketId: market.marketId,
        id,
        requestedBy: 'admin',
        status: { in: ['cancelled', 'completed'] },
        redactedAt: null,
      },
      data: REDACTION(at),
    });
  }

  async insertPending(market: MarketContext, request: AccountDeletionRequest): Promise<boolean> {
    // ON CONFLICT DO NOTHING answers the partial unique index (one open request per account).
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
          requestedBy: request.requestedBy,
          adminAccountId: request.adminOrigin?.adminAccountId ?? null,
          ticketRef: request.adminOrigin?.ticketRef ?? null,
          reason: request.adminOrigin?.reason ?? null,
        },
      ],
      skipDuplicates: true,
    });
    return created.count === 1;
  }

  async findActiveOf(market: MarketContext, accountId: Id<'Account'>) {
    const row = await this.prisma.tx(market).customersAccountDeletionRequest.findFirst({
      where: { marketId: market.marketId, accountId, status: { in: ['pending', 'executing'] } },
    });
    return row === null ? null : toRequest(row);
  }

  async cancel(
    market: MarketContext,
    id: Id<'AccountDeletionRequest'>,
    reason: 'customer' | 'sign-in',
    at: Temporal.Instant,
  ): Promise<boolean> {
    // Only a pending request: a claimed one (executing) matches nothing and stays as it is.
    const { count } = await this.prisma.tx(market).customersAccountDeletionRequest.updateMany({
      where: { marketId: market.marketId, id, status: 'pending' },
      data: { status: 'cancelled', cancelledAt: toDate(at), cancelReason: reason },
    });
    if (count === 1) await this.#redactClosed(market, id, at);
    return count === 1;
  }

  async findById(market: MarketContext, id: Id<'AccountDeletionRequest'>) {
    const row = await this.prisma
      .tx(market)
      .customersAccountDeletionRequest.findFirst({ where: { marketId: market.marketId, id } });
    return row === null ? null : toRequest(row);
  }

  async cancelByAdmin(
    market: MarketContext,
    id: Id<'AccountDeletionRequest'>,
    adminAccountId: Id<'Account'>,
    at: Temporal.Instant,
  ): Promise<boolean> {
    // Only a pending request, as the buyer's cancel: a claimed one matches nothing.
    const { count } = await this.prisma.tx(market).customersAccountDeletionRequest.updateMany({
      where: { marketId: market.marketId, id, status: 'pending' },
      data: {
        status: 'cancelled',
        cancelledAt: toDate(at),
        cancelReason: 'admin',
        cancelledByAdminId: adminAccountId,
      },
    });
    if (count === 1) await this.#redactClosed(market, id, at);
    return count === 1;
  }

  async listPending(
    market: MarketContext,
    page: { readonly after: PendingCursor | null; readonly limit: number },
  ) {
    const { after } = page;
    const rows = await this.prisma.tx(market).customersAccountDeletionRequest.findMany({
      where: {
        marketId: market.marketId,
        status: 'pending',
        ...(after === null
          ? {}
          : {
              OR: [
                { scheduledFor: { gt: toDate(after.scheduledFor) } },
                { scheduledFor: toDate(after.scheduledFor), id: { gt: after.id } },
              ],
            }),
      },
      orderBy: [{ scheduledFor: 'asc' }, { id: 'asc' }],
      take: page.limit,
    });
    return rows.map(toRequest);
  }

  async claim(
    market: MarketContext,
    id: Id<'AccountDeletionRequest'>,
    at: Temporal.Instant,
    staleBefore: Temporal.Instant,
  ): Promise<boolean> {
    const { count } = await this.prisma.tx(market).customersAccountDeletionRequest.updateMany({
      where: {
        marketId: market.marketId,
        id,
        OR: [
          { status: 'pending', scheduledFor: { lte: toDate(at) } },
          { status: 'executing', claimedAt: { lte: toDate(staleBefore) } },
        ],
      },
      data: { status: 'executing', claimedAt: toDate(at) },
    });
    return count === 1;
  }

  async release(
    market: MarketContext,
    id: Id<'AccountDeletionRequest'>,
    claimedAt: Temporal.Instant,
  ): Promise<boolean> {
    const { count } = await this.prisma.tx(market).customersAccountDeletionRequest.updateMany({
      where: { marketId: market.marketId, id, status: 'executing', claimedAt: toDate(claimedAt) },
      data: { status: 'pending', claimedAt: null },
    });
    return count === 1;
  }

  async complete(
    market: MarketContext,
    id: Id<'AccountDeletionRequest'>,
    claimedAt: Temporal.Instant,
    at: Temporal.Instant,
  ): Promise<boolean> {
    const { count } = await this.prisma.tx(market).customersAccountDeletionRequest.updateMany({
      where: { marketId: market.marketId, id, status: 'executing', claimedAt: toDate(claimedAt) },
      data: { status: 'completed', completedAt: toDate(at) },
    });
    if (count === 1) await this.#redactClosed(market, id, at);
    return count === 1;
  }

  async listDue(
    market: MarketContext,
    now: Temporal.Instant,
    staleBefore: Temporal.Instant,
    limit: number,
  ) {
    // Two reads, one partial index each (pending by date, executing by claim time).
    const pending = await this.prisma.tx(market).customersAccountDeletionRequest.findMany({
      where: { marketId: market.marketId, status: 'pending', scheduledFor: { lte: toDate(now) } },
      orderBy: [{ scheduledFor: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    const stale = await this.prisma.tx(market).customersAccountDeletionRequest.findMany({
      where: {
        marketId: market.marketId,
        status: 'executing',
        claimedAt: { lte: toDate(staleBefore) },
      },
      orderBy: [{ claimedAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    // A claim that died is older work than a request that only just fell due: take those first.
    return [...stale, ...pending].slice(0, limit).map(toRequest);
  }
}
