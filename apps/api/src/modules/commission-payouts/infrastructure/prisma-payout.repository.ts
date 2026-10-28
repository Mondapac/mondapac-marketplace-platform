import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  PayoutPage,
  PayoutRepository,
  PayoutWithItems,
  SellerPayoutPosition,
} from '../application/ports/payout.repository';
import type { ApprovalMode } from '../domain/payout-terms';
import {
  COUNTED_STATES,
  LIVE_STATES,
  type ApprovalReason,
  type Payout,
  type PayoutItem,
  type PayoutState,
} from '../domain/payout';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());
const orNull = (date: Date | null): Temporal.Instant | null =>
  date === null ? null : toInstant(date);

interface PayoutRow {
  readonly id: string;
  readonly sellerId: string;
  readonly currency: string;
  readonly grossMinor: bigint;
  readonly nettedMinor: bigint;
  readonly transferMinor: bigint;
  readonly approvalMode: string;
  readonly approvalReason: string | null;
  readonly minimumMinor: bigint;
  readonly slotAt: Date;
  readonly state: string;
  readonly approvedBy: string | null;
  readonly approvedAt: Date | null;
  readonly approvedTransferMinor: bigint | null;
  readonly transferExecutionId: string | null;
  readonly outcomeCode: string | null;
  readonly instructingAt: Date | null;
  readonly abandonedAt: Date | null;
  readonly createdAt: Date;
  readonly stateChangedAt: Date;
  readonly version: number;
}

const toPayout = (row: PayoutRow): Payout => ({
  id: row.id as Id<'Payout'>,
  sellerId: row.sellerId as Id<'Seller'>,
  currency: row.currency,
  gross: row.grossMinor,
  netted: row.nettedMinor,
  transfer: row.transferMinor,
  approvalMode: row.approvalMode as ApprovalMode,
  approvalReason: row.approvalReason as ApprovalReason | null,
  minimum: row.minimumMinor,
  slotAt: toInstant(row.slotAt),
  state: row.state as PayoutState,
  approval:
    row.approvedBy === null || row.approvedAt === null || row.approvedTransferMinor === null
      ? null
      : {
          approvedBy: row.approvedBy as Id<'Account'>,
          approvedAt: toInstant(row.approvedAt),
          approvedTransfer: row.approvedTransferMinor,
        },
  transferExecutionId: row.transferExecutionId,
  outcomeCode: row.outcomeCode,
  instructingAt: orNull(row.instructingAt),
  abandonedAt: orNull(row.abandonedAt),
  createdAt: toInstant(row.createdAt),
  stateChangedAt: toInstant(row.stateChangedAt),
  version: row.version,
});

/** Rows created before the cursor, newest first: `(created_at, id) < (cursor)`. */
const afterCursor = (page: PayoutPage) =>
  page.after === null
    ? {}
    : {
        OR: [
          { createdAt: { lt: toDate(page.after.createdAt) } },
          { createdAt: toDate(page.after.createdAt), id: { lt: page.after.id } },
        ],
      };

const NEWEST_FIRST = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];

/**
 * {@link PayoutRepository} on `commission_payouts.payouts` and `payout_items`, scoped by
 * `marketId` in every `where`. A change is a compare-and-set on the state and version the caller
 * read; the table's guard trigger refuses any transition the state machine does not have.
 */
export class PrismaPayoutRepository implements PayoutRepository {
  constructor(private readonly prisma: PrismaService) {}

  async insert(market: MarketContext, payout: Payout, items: readonly PayoutItem[]) {
    const tx = this.prisma.tx(market);
    await tx.commissionPayoutsPayout.create({
      data: {
        id: payout.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        sellerId: payout.sellerId,
        currency: payout.currency,
        grossMinor: payout.gross,
        nettedMinor: payout.netted,
        transferMinor: payout.transfer,
        approvalMode: payout.approvalMode,
        approvalReason: payout.approvalReason,
        minimumMinor: payout.minimum,
        slotAt: toDate(payout.slotAt),
        state: payout.state,
        instructingAt: payout.instructingAt === null ? null : toDate(payout.instructingAt),
        createdAt: toDate(payout.createdAt),
        stateChangedAt: toDate(payout.stateChangedAt),
        version: payout.version,
      },
    });
    await tx.commissionPayoutsPayoutItem.createMany({
      data: items.map((item) => ({
        marketId: market.marketId,
        tenantId: market.tenantId,
        payoutId: payout.id,
        sellerOrderId: item.sellerOrderId,
        sellerId: payout.sellerId,
        currency: payout.currency,
        amountMinor: item.amount,
      })),
    });
  }

  async find(market: MarketContext, id: Id<'Payout'>) {
    const row = await this.prisma
      .tx(market)
      .commissionPayoutsPayout.findFirst({ where: { marketId: market.marketId, id } });
    return row === null ? null : toPayout(row);
  }

  async findWithItems(market: MarketContext, id: Id<'Payout'>): Promise<PayoutWithItems | null> {
    const row = await this.prisma.tx(market).commissionPayoutsPayout.findFirst({
      where: { marketId: market.marketId, id },
      include: { items: { orderBy: [{ sellerOrderId: 'asc' }] } },
    });
    if (row === null) return null;
    return {
      payout: toPayout(row),
      items: row.items.map((item) => ({
        sellerOrderId: item.sellerOrderId as Id<'SellerOrder'>,
        amount: item.amountMinor,
      })),
    };
  }

  async findByTransferExecution(market: MarketContext, transferExecutionId: string) {
    const row = await this.prisma.tx(market).commissionPayoutsPayout.findFirst({
      where: { marketId: market.marketId, transferExecutionId },
    });
    return row === null ? null : toPayout(row);
  }

  async findLive(market: MarketContext, sellerId: Id<'Seller'>) {
    const row = await this.prisma.tx(market).commissionPayoutsPayout.findFirst({
      where: { marketId: market.marketId, sellerId, state: { in: [...LIVE_STATES] } },
    });
    return row === null ? null : toPayout(row);
  }

  async change(market: MarketContext, before: Payout, after: Payout) {
    const changed = await this.prisma.tx(market).commissionPayoutsPayout.updateMany({
      where: {
        marketId: market.marketId,
        id: before.id,
        state: before.state,
        version: before.version,
      },
      data: {
        state: after.state,
        approvedBy: after.approval?.approvedBy ?? null,
        approvedAt: after.approval === null ? null : toDate(after.approval.approvedAt),
        approvedTransferMinor: after.approval?.approvedTransfer ?? null,
        transferExecutionId: after.transferExecutionId,
        outcomeCode: after.outcomeCode,
        instructingAt: after.instructingAt === null ? null : toDate(after.instructingAt),
        abandonedAt: after.abandonedAt === null ? null : toDate(after.abandonedAt),
        stateChangedAt: toDate(after.stateChangedAt),
        version: after.version,
      },
    });
    return changed.count === 1;
  }

  async position(market: MarketContext, sellerId: Id<'Seller'>): Promise<SellerPayoutPosition> {
    const tx = this.prisma.tx(market);
    const items = await tx.commissionPayoutsPayoutItem.findMany({
      where: { marketId: market.marketId, sellerId, freedAt: null },
      select: { sellerOrderId: true, amountMinor: true, payout: { select: { state: true } } },
    });
    const itemAmounts = new Map<Id<'SellerOrder'>, bigint>();
    const takenAmounts = new Map<Id<'SellerOrder'>, bigint>();
    for (const item of items) {
      const key = item.sellerOrderId as Id<'SellerOrder'>;
      itemAmounts.set(key, item.amountMinor);
      if ((COUNTED_STATES as readonly string[]).includes(item.payout.state)) {
        takenAmounts.set(key, item.amountMinor);
      }
    }
    const netted = await tx.commissionPayoutsPayout.aggregate({
      where: { marketId: market.marketId, sellerId, state: { in: [...COUNTED_STATES] } },
      _sum: { nettedMinor: true },
    });
    const paid = await tx.commissionPayoutsPayout.count({
      where: { marketId: market.marketId, sellerId, state: 'paid' },
    });
    return {
      itemAmounts,
      takenAmounts,
      nettedTotal: netted._sum.nettedMinor ?? 0n,
      hasPaid: paid > 0,
    };
  }

  async listByState(market: MarketContext, states: readonly PayoutState[], limit: number) {
    const rows = await this.prisma.tx(market).commissionPayoutsPayout.findMany({
      where: { marketId: market.marketId, state: { in: [...states] } },
      orderBy: [{ stateChangedAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return rows.map(toPayout);
  }

  async list(
    market: MarketContext,
    filter: { readonly state: PayoutState | null },
    page: PayoutPage,
  ) {
    const rows = await this.prisma.tx(market).commissionPayoutsPayout.findMany({
      where: {
        marketId: market.marketId,
        ...(filter.state === null ? {} : { state: filter.state }),
        ...afterCursor(page),
      },
      orderBy: NEWEST_FIRST,
      take: page.limit,
    });
    return rows.map(toPayout);
  }

  async listForSeller(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    hidden: readonly PayoutState[],
    page: PayoutPage,
  ) {
    const rows = await this.prisma.tx(market).commissionPayoutsPayout.findMany({
      where: {
        marketId: market.marketId,
        sellerId,
        ...(hidden.length === 0 ? {} : { state: { notIn: [...hidden] } }),
        ...afterCursor(page),
      },
      orderBy: NEWEST_FIRST,
      take: page.limit,
    });
    return rows.map(toPayout);
  }

  async sumTransferredSince(market: MarketContext, since: Temporal.Instant) {
    const sum = await this.prisma.tx(market).commissionPayoutsPayout.aggregate({
      where: {
        marketId: market.marketId,
        state: { in: ['instructed', 'paid'] },
        stateChangedAt: { gte: toDate(since) },
      },
      _sum: { transferMinor: true },
    });
    return sum._sum.transferMinor ?? 0n;
  }
}
