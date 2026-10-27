import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  AdminCreditDecision,
  AdminCreditPage,
  AdminCreditRecord,
  AdminCreditRepository,
  NewAdminCredit,
} from '../application/ports/admin-credit.repository';
import {
  COUNTED_STATUSES,
  type AdminCreditReason,
  type AdminCreditRejectReason,
  type AdminCreditStatus,
  type ApprovalReason,
} from '../domain/admin-credit';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());
/** A `date` column: the calendar day at UTC midnight, as Prisma reads and writes it. */
const dayDate = (localDay: string): Date => new Date(`${localDay}T00:00:00.000Z`);
const dayText = (date: Date): string => date.toISOString().slice(0, 10);

interface Row {
  readonly id: string;
  readonly customerAccountId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly reasonCode: string;
  readonly note: string | null;
  readonly status: string;
  readonly approvalReason: string | null;
  readonly requestedByAccountId: string;
  readonly requestedAt: Date;
  readonly localDay: Date;
  readonly expiresAt: Date | null;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly decidedByAccountId: string | null;
  readonly decidedAt: Date | null;
  readonly decisionReasonCode: string | null;
  readonly journalId: string | null;
}

const toRecord = (row: Row): AdminCreditRecord => ({
  id: row.id as Id<'WalletCreditRequest'>,
  customerAccountId: row.customerAccountId as Id<'Account'>,
  amountMinor: row.amountMinor,
  currency: row.currency,
  reasonCode: row.reasonCode as AdminCreditReason,
  note: row.note,
  status: row.status as AdminCreditStatus,
  approvalReason: row.approvalReason as ApprovalReason | null,
  requestedBy: row.requestedByAccountId as Id<'Account'>,
  requestedAt: toInstant(row.requestedAt),
  localDay: dayText(row.localDay),
  expiresAt: row.expiresAt === null ? null : toInstant(row.expiresAt),
  idempotencyKey: row.idempotencyKey,
  fingerprint: row.fingerprint,
  decidedBy: row.decidedByAccountId as Id<'Account'> | null,
  decidedAt: row.decidedAt === null ? null : toInstant(row.decidedAt),
  decisionReason: row.decisionReasonCode as AdminCreditRejectReason | null,
  journalId: row.journalId as Id<'WalletJournal'> | null,
});

/**
 * {@link AdminCreditRepository} on `wallet.admin_credit_requests` and `wallet.admin_credit_days`,
 * scoped by `marketId` in every `where`. Row locks are no-change or own-column updates (as the
 * balance lock), held until the unit ends.
 */
export class PrismaAdminCreditRepository implements AdminCreditRepository {
  constructor(private readonly prisma: PrismaService) {}

  async lockDay(
    market: MarketContext,
    adminAccountId: Id<'Account'>,
    localDay: string,
    now: Temporal.Instant,
  ) {
    const tx = this.prisma.tx(market);
    const key = { marketId: market.marketId, adminAccountId, localDay: dayDate(localDay) };
    // Seeded once (ON CONFLICT DO NOTHING), then locked: two first issues of a day queue on it.
    await tx.walletAdminCreditDay.createMany({
      data: [{ ...key, tenantId: market.tenantId, lockedAt: toDate(now) }],
      skipDuplicates: true,
    });
    await tx.walletAdminCreditDay.updateMany({ where: key, data: { lockedAt: toDate(now) } });
  }

  async countedOnDay(market: MarketContext, adminAccountId: Id<'Account'>, localDay: string) {
    const sum = await this.prisma.tx(market).walletAdminCreditRequest.aggregate({
      where: {
        marketId: market.marketId,
        requestedByAccountId: adminAccountId,
        localDay: dayDate(localDay),
        status: { in: [...COUNTED_STATUSES] },
      },
      _sum: { amountMinor: true },
    });
    return sum._sum.amountMinor ?? 0n;
  }

  async findByKey(market: MarketContext, idempotencyKey: string) {
    const row = await this.prisma.tx(market).walletAdminCreditRequest.findFirst({
      where: { marketId: market.marketId, idempotencyKey },
    });
    return row === null ? null : toRecord(row);
  }

  async find(market: MarketContext, id: Id<'WalletCreditRequest'>) {
    const row = await this.prisma.tx(market).walletAdminCreditRequest.findFirst({
      where: { marketId: market.marketId, id },
    });
    return row === null ? null : toRecord(row);
  }

  async findForUpdate(market: MarketContext, id: Id<'WalletCreditRequest'>) {
    const tx = this.prisma.tx(market);
    const seen = await tx.walletAdminCreditRequest.findFirst({
      where: { marketId: market.marketId, id },
      select: { status: true },
    });
    if (seen === null) return null;
    // A no-change update takes the row lock; the read after it sees what was committed before.
    // It matches the status read, so a row decided meanwhile is never written back.
    await tx.walletAdminCreditRequest.updateMany({
      where: { marketId: market.marketId, id, status: seen.status },
      data: { status: seen.status },
    });
    return this.find(market, id);
  }

  async create(market: MarketContext, record: NewAdminCredit) {
    await this.prisma.tx(market).walletAdminCreditRequest.create({
      data: {
        id: record.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        customerAccountId: record.customerAccountId,
        amountMinor: record.amountMinor,
        currency: record.currency,
        reasonCode: record.reasonCode,
        note: record.note,
        status: record.status,
        approvalReason: record.approvalReason,
        requestedByAccountId: record.requestedBy,
        requestedAt: toDate(record.requestedAt),
        localDay: dayDate(record.localDay),
        expiresAt: record.expiresAt === null ? null : toDate(record.expiresAt),
        idempotencyKey: record.idempotencyKey,
        fingerprint: record.fingerprint,
        journalId: record.journalId,
      },
    });
  }

  async decide(
    market: MarketContext,
    id: Id<'WalletCreditRequest'>,
    decision: AdminCreditDecision,
  ) {
    const updated = await this.prisma.tx(market).walletAdminCreditRequest.updateMany({
      where: { marketId: market.marketId, id, status: 'pending' },
      data: {
        status: decision.status,
        decidedByAccountId: decision.decidedBy,
        decidedAt: toDate(decision.decidedAt),
        decisionReasonCode: decision.decisionReason,
        journalId: decision.journalId,
      },
    });
    return updated.count === 1;
  }

  async list(market: MarketContext, page: AdminCreditPage) {
    const after = page.after;
    const rows = await this.prisma.tx(market).walletAdminCreditRequest.findMany({
      where: {
        marketId: market.marketId,
        status: { in: [...page.statuses] },
        ...(after === null
          ? {}
          : {
              OR: [
                { requestedAt: { lt: toDate(after.requestedAt) } },
                { requestedAt: toDate(after.requestedAt), id: { lt: after.id } },
              ],
            }),
      },
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
      take: page.limit,
    });
    return rows.map(toRecord);
  }

  async duePending(market: MarketContext, now: Temporal.Instant, limit: number) {
    const rows = await this.prisma.tx(market).walletAdminCreditRequest.findMany({
      where: { marketId: market.marketId, status: 'pending', expiresAt: { lte: toDate(now) } },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true },
    });
    return rows.map((row) => row.id as Id<'WalletCreditRequest'>);
  }
}
