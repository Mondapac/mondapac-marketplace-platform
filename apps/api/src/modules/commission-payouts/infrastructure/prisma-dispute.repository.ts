import { money, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  DisputePage,
  DisputeRepository,
  SellerOrderRef,
} from '../application/ports/dispute.repository';
import {
  DISPUTE_BUCKETS,
  type DecisionBearer,
  type DecisionReasonCode,
  type DisputeBucket,
  type DisputeCase,
  type DisputeDecision,
  type DisputeStatus,
} from '../domain/dispute';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());
const optionalInstant = (date: Date | null) => (date === null ? null : toInstant(date));
const optionalDate = (instant: Temporal.Instant | null) =>
  instant === null ? null : toDate(instant);

interface CaseRow {
  readonly disputeId: string;
  readonly orderId: string;
  readonly providerDisputeId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly status: string;
  readonly inquiry: boolean;
  readonly closed: boolean;
  readonly outcome: string | null;
  readonly reason: string;
  readonly evidenceDueBy: Date | null;
  readonly fundsWithdrawn: boolean;
  readonly fundsWithdrawnAt: Date | null;
  readonly fundsReinstated: boolean;
  readonly fundsReinstatedAt: Date | null;
  readonly openedAt: Date;
  readonly closedAt: Date | null;
  readonly bucket: string;
  readonly lastSyncedVersion: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const toCase = (row: CaseRow): DisputeCase => ({
  disputeId: row.disputeId as Id<'Dispute'>,
  orderId: row.orderId as Id<'Order'>,
  providerDisputeId: row.providerDisputeId,
  amount: money(row.amountMinor, row.currency),
  // The CHECKs keep these to the known values.
  status: row.status as DisputeStatus,
  inquiry: row.inquiry,
  closed: row.closed,
  outcome: row.outcome as 'won' | 'lost' | null,
  reason: row.reason,
  evidenceDueBy: optionalInstant(row.evidenceDueBy),
  fundsWithdrawn: row.fundsWithdrawn,
  fundsWithdrawnAt: optionalInstant(row.fundsWithdrawnAt),
  fundsReinstated: row.fundsReinstated,
  fundsReinstatedAt: optionalInstant(row.fundsReinstatedAt),
  openedAt: toInstant(row.openedAt),
  closedAt: optionalInstant(row.closedAt),
  bucket: row.bucket as DisputeBucket,
  lastSyncedVersion: row.lastSyncedVersion,
  createdAt: toInstant(row.createdAt),
  updatedAt: toInstant(row.updatedAt),
});

const stateData = (c: DisputeCase) => ({
  status: c.status,
  inquiry: c.inquiry,
  closed: c.closed,
  outcome: c.outcome,
  reason: c.reason,
  evidenceDueBy: optionalDate(c.evidenceDueBy),
  fundsWithdrawn: c.fundsWithdrawn,
  fundsWithdrawnAt: optionalDate(c.fundsWithdrawnAt),
  fundsReinstated: c.fundsReinstated,
  fundsReinstatedAt: optionalDate(c.fundsReinstatedAt),
  closedAt: optionalDate(c.closedAt),
  bucket: c.bucket,
  lastSyncedVersion: c.lastSyncedVersion,
  updatedAt: toDate(c.updatedAt),
});

interface DecisionRow {
  readonly id: string;
  readonly disputeId: string;
  readonly sellerOrderId: string;
  readonly sellerId: string;
  readonly bearer: string;
  readonly amountMinor: bigint | null;
  readonly currency: string | null;
  readonly reasonCode: string;
  readonly decidedBy: string;
  readonly decidedAt: Date;
  readonly supersedes: string | null;
}

const toDecision = (row: DecisionRow): DisputeDecision => ({
  id: row.id as Id<'DisputeDecision'>,
  disputeId: row.disputeId as Id<'Dispute'>,
  sellerOrderId: row.sellerOrderId as Id<'SellerOrder'>,
  sellerId: row.sellerId as Id<'Seller'>,
  bearer: row.bearer as DecisionBearer,
  amount:
    row.amountMinor === null || row.currency === null ? null : money(row.amountMinor, row.currency),
  reasonCode: row.reasonCode as DecisionReasonCode,
  decidedBy: row.decidedBy as Id<'Account'>,
  decidedAt: toInstant(row.decidedAt),
  supersedes: row.supersedes as Id<'DisputeDecision'> | null,
});

/**
 * {@link DisputeRepository} on `commission_payouts.dispute_cases`, `dispute_decisions` and (for the
 * seller orders of an order) the ledger, scoped by `marketId` in every `where`.
 */
export class PrismaDisputeRepository implements DisputeRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(market: MarketContext, disputeId: Id<'Dispute'>) {
    const row = await this.prisma.tx(market).commissionPayoutsDisputeCase.findFirst({
      where: { marketId: market.marketId, disputeId },
    });
    return row === null ? null : toCase(row);
  }

  async insert(market: MarketContext, c: DisputeCase) {
    const created = await this.prisma.tx(market).commissionPayoutsDisputeCase.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          disputeId: c.disputeId,
          orderId: c.orderId,
          providerDisputeId: c.providerDisputeId,
          amountMinor: c.amount.amount,
          currency: c.amount.currency,
          openedAt: toDate(c.openedAt),
          createdAt: toDate(c.createdAt),
          ...stateData(c),
        },
      ],
      skipDuplicates: true,
    });
    return created.count > 0;
  }

  async refresh(market: MarketContext, next: DisputeCase) {
    const updated = await this.prisma.tx(market).commissionPayoutsDisputeCase.updateMany({
      where: {
        marketId: market.marketId,
        disputeId: next.disputeId,
        lastSyncedVersion: { lte: next.lastSyncedVersion },
      },
      data: stateData(next),
    });
    return updated.count > 0;
  }

  async setBucket(
    market: MarketContext,
    disputeId: Id<'Dispute'>,
    bucket: DisputeBucket,
    now: Temporal.Instant,
  ) {
    await this.prisma.tx(market).commissionPayoutsDisputeCase.updateMany({
      where: { marketId: market.marketId, disputeId },
      data: { bucket, updatedAt: toDate(now) },
    });
  }

  async list(market: MarketContext, page: DisputePage) {
    const after = page.after;
    const rows = await this.prisma.tx(market).commissionPayoutsDisputeCase.findMany({
      where: {
        marketId: market.marketId,
        ...(page.bucket === null ? {} : { bucket: page.bucket }),
        ...(after === null
          ? {}
          : {
              OR: [
                { openedAt: { lt: toDate(after.openedAt) } },
                { openedAt: toDate(after.openedAt), disputeId: { lt: after.disputeId } },
              ],
            }),
      },
      orderBy: [{ openedAt: 'desc' }, { disputeId: 'desc' }],
      take: page.limit,
    });
    return rows.map(toCase);
  }

  async counts(market: MarketContext) {
    const groups = await this.prisma.tx(market).commissionPayoutsDisputeCase.groupBy({
      by: ['bucket'],
      where: { marketId: market.marketId },
      _count: { _all: true },
    });
    const counts = new Map<DisputeBucket, number>();
    for (const group of groups) {
      if ((DISPUTE_BUCKETS as readonly string[]).includes(group.bucket)) {
        counts.set(group.bucket as DisputeBucket, group._count._all);
      }
    }
    return counts;
  }

  async findMany(market: MarketContext, disputeIds: readonly Id<'Dispute'>[]) {
    if (disputeIds.length === 0) return [];
    const rows = await this.prisma.tx(market).commissionPayoutsDisputeCase.findMany({
      where: { marketId: market.marketId, disputeId: { in: [...disputeIds] } },
    });
    return rows.map(toCase);
  }

  async sellerOrdersOfOrder(market: MarketContext, orderId: Id<'Order'>) {
    return this.sellerOrdersOfOrders(market, [orderId]);
  }

  async sellerOrdersOfOrders(
    market: MarketContext,
    orderIds: readonly Id<'Order'>[],
  ): Promise<readonly SellerOrderRef[]> {
    if (orderIds.length === 0) return [];
    const groups = await this.prisma.tx(market).commissionPayoutsLedgerEntry.groupBy({
      by: ['sellerOrderId', 'sellerId', 'orderId'],
      where: { marketId: market.marketId, orderId: { in: [...orderIds] } },
      orderBy: [{ sellerOrderId: 'asc' }],
    });
    return groups.map((group) => ({
      sellerOrderId: group.sellerOrderId as Id<'SellerOrder'>,
      sellerId: group.sellerId as Id<'Seller'>,
      orderId: group.orderId as Id<'Order'>,
    }));
  }

  async decisionsOf(market: MarketContext, disputeId: Id<'Dispute'>) {
    const rows = await this.prisma.tx(market).commissionPayoutsDisputeDecision.findMany({
      where: { marketId: market.marketId, disputeId },
      orderBy: [{ decidedAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toDecision);
  }

  async decisionsForSeller(market: MarketContext, sellerId: Id<'Seller'>) {
    const rows = await this.prisma.tx(market).commissionPayoutsDisputeDecision.findMany({
      where: { marketId: market.marketId, sellerId },
      orderBy: [{ decidedAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toDecision);
  }

  async lockForDecision(
    market: MarketContext,
    disputeId: Id<'Dispute'>,
    sellerOrderId: Id<'SellerOrder'>,
  ) {
    const found = await this.prisma.namedQuery(market, 'commission-payouts.lock-dispute-case', {
      disputeId,
    });
    if (found.length === 0) return false;
    await this.prisma.namedQuery(market, 'commission-payouts.lock-seller-order', {
      sellerOrderId,
    });
    return true;
  }

  async lockCase(market: MarketContext, disputeId: Id<'Dispute'>) {
    const found = await this.prisma.namedQuery(market, 'commission-payouts.lock-dispute-case', {
      disputeId,
    });
    return found.length > 0;
  }

  async insertDecision(market: MarketContext, decision: DisputeDecision) {
    const created = await this.prisma.tx(market).commissionPayoutsDisputeDecision.createMany({
      data: [
        {
          id: decision.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          disputeId: decision.disputeId,
          sellerOrderId: decision.sellerOrderId,
          sellerId: decision.sellerId,
          bearer: decision.bearer,
          amountMinor: decision.amount === null ? null : decision.amount.amount,
          currency: decision.amount === null ? null : decision.amount.currency,
          reasonCode: decision.reasonCode,
          decidedBy: decision.decidedBy,
          decidedAt: toDate(decision.decidedAt),
          supersedes: decision.supersedes,
        },
      ],
      skipDuplicates: true,
    });
    return created.count > 0;
  }
}
